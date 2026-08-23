import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { spawnWithEnv } from "@divisio/shared/spawn";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PRODUCT_SLUG } from "@divisio/shared/brand";
import { resolveHome } from "@divisio/shared/paths";
import { logger } from "@divisio/shared/log";
import type { DiffFileEntry } from "@divisio/contracts";
import { attachLineCounts, numstatMap, parseNameStatusLine } from "../git/diffMeta.ts";

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
  const proc = spawnWithEnv(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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

  const proc = spawnWithEnv(["sh", "-c", command], {
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

/** Short branch name for the checkout, or null when detached / not a repo. */
export async function currentBranch(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0 || !r.stdout || r.stdout === "HEAD") return null;
  return r.stdout;
}

/**
 * Live working-tree changes vs HEAD (tracked) plus untracked paths from
 * porcelain status. Untracked files appear in the file list; their content is
 * omitted from the patch until the user stages them.
 */
export async function diffWorkingTree(root: string) {
  if (!(await isGitRepo(root))) {
    return { files: [] as DiffFileEntry[], patch: null, status: "skipped" as const, detail: "not a git repository" };
  }

  const status = await git(root, ["status", "--porcelain", "-uall"]);
  if (status.code !== 0) {
    return { files: [], patch: null, status: "error" as const, detail: status.stderr || "git status failed" };
  }

  const files = status.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => parsePorcelainLine(line))
    .filter((f): f is DiffFileEntry => !!f);

  const patch = await git(root, ["diff", "HEAD"]);
  const numstat = await git(root, ["diff", "--numstat", "HEAD"]);
  const counted = numstat.code === 0 ? attachLineCounts(files, numstatMap(numstat.stdout)) : files;
  return {
    files: counted,
    patch: patch.code === 0 ? patch.stdout || null : null,
    status: "ready" as const,
  };
}

/** Parses one `git status --porcelain` line into a DiffFileEntry-shaped row. */
export function parsePorcelainLine(line: string): DiffFileEntry | null {
  if (line.length < 4) return null;
  const x = line[0] ?? " ";
  const y = line[1] ?? " ";
  let path = line.slice(3);
  // Rename: "R  old -> new" or "RM old -> new"
  if (path.includes(" -> ")) {
    path = path.split(" -> ").pop()!.trim();
  }
  if (!path) return null;

  if (x === "?" && y === "?") return { path, status: "A" };
  if (x === "A" || y === "A") return { path, status: "A" };
  if (x === "D" || y === "D") return { path, status: "D" };
  if (x === "R" || y === "R") return { path, status: "R" };
  if (x === "M" || y === "M" || x === "U" || y === "U") return { path, status: "M" };
  return { path, status: "?" };
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
    .map((line) => parseNameStatusLine(line))
    .filter((f): f is DiffFileEntry => !!f);

  const patch = await git(root, ["diff", baseSha]);
  const numstat = await git(root, ["diff", "--numstat", baseSha]);
  const counted = numstat.code === 0 ? attachLineCounts(files, numstatMap(numstat.stdout)) : files;
  return { files: counted, patch: patch.code === 0 ? patch.stdout || null : null, status: "ready" as const };
}

export async function headSha(projectRoot: string): Promise<string | null> {
  const r = await git(projectRoot, ["rev-parse", "--verify", "HEAD"]);
  return r.code === 0 ? r.stdout : null;
}

/* ------------------------------ delivery ---------------------------------- */

export interface RemoteInfo {
  name: string;
  url: string;
  /** `owner/repo` when the remote is recognisably GitHub. */
  slug: string | null;
}

/**
 * Parses `owner/repo` out of a remote URL.
 * Handles the SSH and HTTPS forms; anything else yields a null slug, which
 * degrades to "pushed, no compare link" rather than a wrong URL.
 */
export function parseGitHubSlug(url: string): string | null {
  const ssh = url.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (ssh?.[1]) return ssh[1];
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/(.+?)(?:\.git)?\/?$/);
  if (https?.[1]) return https[1];
  return null;
}

export async function getRemote(root: string): Promise<RemoteInfo | null> {
  const name = await git(root, ["remote"]);
  if (name.code !== 0 || !name.stdout) return null;
  const first = name.stdout.split("\n")[0]?.trim();
  if (!first) return null;
  const url = await git(root, ["remote", "get-url", first]);
  if (url.code !== 0 || !url.stdout) return null;
  return { name: first, url: url.stdout, slug: parseGitHubSlug(url.stdout) };
}

/** Commits selected paths, or everything when `paths` is omitted / empty. */
export async function commitAll(
  root: string,
  message: string,
  paths?: string[],
): Promise<{ ok: boolean; detail?: string }> {
  const addArgs =
    paths && paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
  const add = await git(root, addArgs);
  if (add.code !== 0) return { ok: false, detail: add.stderr || "git add failed" };
  const commit = await git(root, ["commit", "-m", message]);
  if (commit.code !== 0) return { ok: false, detail: commit.stderr || commit.stdout || "git commit failed" };
  return { ok: true };
}

export async function pushBranch(root: string, remote: string, branch: string): Promise<{ ok: boolean; detail?: string }> {
  const push = await git(root, ["push", "-u", remote, branch]);
  if (push.code !== 0) return { ok: false, detail: push.stderr || "git push failed" };
  return { ok: true };
}

/** `gh` is optional. Its absence degrades the flow, never breaks it. */
export async function hasGh(): Promise<boolean> {
  try {
    const proc = spawnWithEnv(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function createPrWithGh(
  root: string,
  base: string,
  title: string,
  body: string,
): Promise<{ ok: boolean; url?: string; detail?: string }> {
  // gh uses the user's own credentials; Divisio never sees or proxies them.
  const proc = spawnWithEnv(["gh", "pr", "create", "--base", base, "--title", title, "--body", body], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if ((await proc.exited) !== 0) return { ok: false, detail: stderr || "gh pr create failed" };
  const url = stdout.split("\n").find((l) => l.startsWith("http"))?.trim();
  return { ok: true, ...(url ? { url } : {}) };
}

export function compareUrl(slug: string, base: string, branch: string): string {
  return `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}

/** Branch the lane should target: the remote's default branch when known. */
export async function defaultBaseBranch(root: string, remote: string): Promise<string> {
  const symbolic = await git(root, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (symbolic.code === 0 && symbolic.stdout) {
    const name = symbolic.stdout.split("/").pop();
    if (name) return name;
  }
  for (const candidate of ["main", "master"]) {
    const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`]);
    if (exists.code === 0) return candidate;
  }
  return "main";
}
