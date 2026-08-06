import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PRODUCT_SLUG } from "@divisio/shared/brand";
import { resolveHome } from "@divisio/shared/paths";
import { logger } from "@divisio/shared/log";

const log = logger("lane");

/**
 * Git worktree lanes. Implements docs/specs/worktrees.md.
 *
 * The git plumbing here is the easy half. The hard half is that a fresh
 * worktree contains only tracked files — no dependencies, no .env, no
 * agent-local settings — so an agent dropped into one cannot build or test
 * anything until carry-over and setup have run.
 */

export interface LaneConfig {
  /** Untracked files copied into a new lane. Copied, never symlinked. */
  carryOver: string[];
  /** Runs once at lane creation, e.g. `bun install`. */
  setup: string | null;
  /** Env var names that receive the lane's allocated port. */
  portEnv: string[];
}

const DEFAULT_CONFIG: LaneConfig = {
  carryOver: [".env", ".env.local", ".env.development.local", ".mcp.json"],
  setup: null,
  portEnv: ["PORT"],
};

/** Never copied regardless of configuration. */
const CARRY_OVER_DENYLIST = new Set([".git", "node_modules", "dist", "build", "target", ".next"]);

/** Guards against a config entry pulling in a multi-gigabyte directory. */
const MAX_CARRY_OVER_BYTES = 8 * 1024 * 1024;

export function lanesRoot(): string {
  // Outside the repository on purpose: a lane nested in the primary checkout
  // gets picked up by that checkout's file watchers, and an agent searching
  // "the repo" reads other lanes as if they were project source.
  return join(resolveHome(), "worktrees");
}

export function laneRoot(projectId: string, laneId: string): string {
  return join(lanesRoot(), projectId, laneId);
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout === "true";
}

export async function loadLaneConfig(projectRoot: string): Promise<LaneConfig> {
  const path = join(projectRoot, `.${PRODUCT_SLUG}`, "project.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { lane?: Partial<LaneConfig> };
    const lane = parsed.lane ?? {};
    return {
      carryOver: Array.isArray(lane.carryOver) ? lane.carryOver : DEFAULT_CONFIG.carryOver,
      setup: typeof lane.setup === "string" && lane.setup.trim() ? lane.setup : null,
      portEnv: Array.isArray(lane.portEnv) && lane.portEnv.length ? lane.portEnv : DEFAULT_CONFIG.portEnv,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** `divisio/<slug>`, uniquified against existing branches rather than reused. */
export async function allocateBranch(projectRoot: string, title: string): Promise<string> {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "lane";

  const base = `${PRODUCT_SLUG}/${slug}`;
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const exists = await git(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (exists.code !== 0) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Binds a port to confirm it is genuinely free rather than assuming.
 * The lane keeps this port for its lifetime so preview URLs stay valid.
 */
export function allocatePort(taken: ReadonlySet<number>): number {
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = 5200 + Math.floor(Math.random() * 2000);
    if (taken.has(candidate)) continue;
    try {
      const server = Bun.listen({ hostname: "127.0.0.1", port: candidate, socket: { data() {} } });
      server.stop(true);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("could not allocate a free port for the lane");
}

export interface CreateResult {
  root: string;
  branch: string;
  baseSha: string;
}

export async function createWorktree(
  projectRoot: string,
  projectId: string,
  laneId: string,
  branch: string,
  base: string,
): Promise<CreateResult> {
  const root = laneRoot(projectId, laneId);
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });

  const baseRev = await git(projectRoot, ["rev-parse", "--verify", base]);
  if (baseRev.code !== 0) throw new Error(`base revision not found: ${base}`);

  const add = await git(projectRoot, ["worktree", "add", "-b", branch, root, baseRev.stdout]);
  if (add.code !== 0) {
    // Git refuses to check a branch out twice. That refusal is correct and is
    // surfaced, never forced.
    throw new Error(add.stderr || "git worktree add failed");
  }

  return { root, branch, baseSha: baseRev.stdout };
}

/**
 * Copies untracked-but-required files into the lane.
 *
 * Copy, never symlink: a symlinked `.env` means the agent writes through into
 * the user's primary checkout, which is the exact cross-contamination worktrees
 * exist to prevent — and worse, because the user believes they are isolated.
 */
export async function copyCarryOver(
  projectRoot: string,
  root: string,
  entries: string[],
): Promise<{ copied: string[]; skipped: string[] }> {
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    // Refuse anything that escapes the project, whether via `..` or an
    // absolute path. A config file should not be able to read /etc.
    if (isAbsolute(entry) || relative(projectRoot, resolve(projectRoot, entry)).startsWith("..")) {
      skipped.push(entry);
      log.warn("carry-over entry outside project, skipped", { entry });
      continue;
    }
    const head = entry.split("/")[0] ?? entry;
    if (CARRY_OVER_DENYLIST.has(head)) {
      skipped.push(entry);
      continue;
    }

    const from = join(projectRoot, entry);
    if (!existsSync(from)) continue;

    try {
      const info = await stat(from);
      if (info.isFile() && info.size > MAX_CARRY_OVER_BYTES) {
        skipped.push(entry);
        log.warn("carry-over entry too large, skipped", { entry, size: info.size });
        continue;
      }
      const to = join(root, entry);
      await mkdir(dirname(to), { recursive: true });
      // dereference: copy the contents a symlink points at, never the link,
      // so the lane cannot end up pointing back into the primary checkout.
      await cp(from, to, { recursive: true, dereference: true, force: true });
      copied.push(entry);
    } catch (err) {
      skipped.push(entry);
      log.warn("carry-over copy failed", { entry, detail: String(err) });
    }
  }

  return { copied, skipped };
}

export interface SetupResult {
  ok: boolean;
  output: string;
}

/** Runs the declared setup command with the lane's port injected. */
export async function runSetup(
  root: string,
  command: string,
  port: number,
  portEnv: string[],
  onOutput?: (chunk: string) => void,
): Promise<SetupResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const name of portEnv) env[name] = String(port);

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      output += text;
      onOutput?.(text);
    }
  };

  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  return { ok: code === 0, output: output.slice(-8000) };
}

export async function isDirty(root: string): Promise<boolean> {
  const r = await git(root, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.length > 0;
}

/**
 * Removes the worktree. Git's refusal on a dirty tree is kept as the default;
 * `force` is only reachable after an explicit, informed confirmation upstream.
 */
export async function removeWorktree(
  projectRoot: string,
  root: string,
  branch: string,
  deleteBranch: boolean,
  force: boolean,
): Promise<void> {
  const args = ["worktree", "remove", root];
  if (force) args.push("--force");
  const removed = await git(projectRoot, args);

  if (removed.code !== 0) {
    if (!force) throw new Error(removed.stderr || "git worktree remove failed");
    // Directory already gone by other means; reconcile the registry instead.
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await git(projectRoot, ["worktree", "prune"]);
  }

  if (deleteBranch) {
    const del = await git(projectRoot, ["branch", force ? "-D" : "-d", branch]);
    if (del.code !== 0) log.warn("branch not deleted", { branch, detail: del.stderr });
  }
}

/** Reconciles worktrees deleted outside the app. */
export async function pruneWorktrees(projectRoot: string): Promise<void> {
  await git(projectRoot, ["worktree", "prune"]);
}

export async function diffLane(root: string, baseSha: string) {
  const names = await git(root, ["diff", "--name-status", baseSha]);
  if (names.code !== 0) {
    return { files: [], patch: null, status: "error" as const, detail: names.stderr };
  }
  const files = names.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const [statusRaw, ...rest] = line.split("\t");
      const char = (statusRaw?.[0] ?? "?") as "A" | "M" | "D" | "R" | "?";
      return {
        path: rest.join("\t"),
        status: (["A", "M", "D", "R"].includes(char) ? char : "?") as "A" | "M" | "D" | "R" | "?",
      };
    })
    .filter((f) => f.path);

  const patch = await git(root, ["diff", baseSha]);
  return { files, patch: patch.code === 0 ? patch.stdout || null : null, status: "ready" as const };
}

export async function headSha(projectRoot: string): Promise<string | null> {
  const r = await git(projectRoot, ["rev-parse", "--verify", "HEAD"]);
  return r.code === 0 ? r.stdout : null;
}
