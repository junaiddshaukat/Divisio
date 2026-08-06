/**
 * Turn checkpoints — hidden git refs for pre/post turn snapshots.
 *
 * MVP: capture working-tree state into `refs/divisio/checkpoints/...` without
 * moving HEAD. Non-git directories return `skipped` so chat still works.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnWithEnv } from "@divisio/shared/spawn";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_SLUG } from "@divisio/shared/brand";
import type { DiffFileEntry } from "@divisio/contracts";
import { logger } from "@divisio/shared/log";

const log = logger("checkpoint");

export interface CaptureResult {
  ref: string;
  sha: string | null;
  status: "ready" | "skipped" | "error";
  detail?: string;
}

export interface DiffResult {
  files: DiffFileEntry[];
  patch: string | null;
  status: "ready" | "skipped" | "error" | "missing";
  detail?: string;
}

export function checkpointRef(threadId: string, turnId: string, phase: "pre" | "post"): string {
  // Git refnames: no spaces; keep ids opaque.
  return `refs/${PRODUCT_SLUG}/checkpoints/${threadId}/${turnId}/${phase}`;
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = spawnWithEnv(["git", ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout === "true";
}

/**
 * Snapshot the current working tree into a hidden ref (does not update HEAD).
 */
export async function captureCheckpoint(
  cwd: string,
  threadId: string,
  turnId: string,
  phase: "pre" | "post",
): Promise<CaptureResult> {
  const ref = checkpointRef(threadId, turnId, phase);

  if (!(await isGitRepo(cwd))) {
    return { ref, sha: null, status: "skipped", detail: "not a git repository" };
  }

  const indexDir = await mkdtemp(join(tmpdir(), "divisio-idx-"));
  const indexFile = join(indexDir, "index");

  try {
    // Seed from HEAD if it exists; empty tree for brand-new repos is fine.
    const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    if (head.code === 0) {
      await git(cwd, ["read-tree", "HEAD"], { GIT_INDEX_FILE: indexFile });
    } else {
      await writeFile(indexFile, "");
    }

    const add = await git(cwd, ["add", "-A"], { GIT_INDEX_FILE: indexFile });
    if (add.code !== 0) {
      return { ref, sha: null, status: "error", detail: add.stderr || "git add failed" };
    }

    const tree = await git(cwd, ["write-tree"], { GIT_INDEX_FILE: indexFile });
    if (tree.code !== 0 || !tree.stdout) {
      return { ref, sha: null, status: "error", detail: tree.stderr || "write-tree failed" };
    }

    const msg = `divisio checkpoint ${phase} ${turnId}`;
    const commitArgs = ["commit-tree", tree.stdout, "-m", msg];
    if (head.code === 0) commitArgs.push("-p", "HEAD");

    const commit = await git(cwd, commitArgs, { GIT_INDEX_FILE: indexFile });
    if (commit.code !== 0 || !commit.stdout) {
      return { ref, sha: null, status: "error", detail: commit.stderr || "commit-tree failed" };
    }

    const update = await git(cwd, ["update-ref", ref, commit.stdout]);
    if (update.code !== 0) {
      return { ref, sha: null, status: "error", detail: update.stderr || "update-ref failed" };
    }

    return { ref, sha: commit.stdout, status: "ready" };
  } catch (err) {
    log.warn("checkpoint capture failed", { detail: String(err) });
    return { ref, sha: null, status: "error", detail: String(err) };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function diffCheckpoints(
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<DiffResult> {
  if (!(await isGitRepo(cwd))) {
    return { files: [], patch: null, status: "skipped", detail: "not a git repository" };
  }

  const from = await git(cwd, ["rev-parse", "--verify", fromRef]);
  const to = await git(cwd, ["rev-parse", "--verify", toRef]);
  if (from.code !== 0 || to.code !== 0) {
    return {
      files: [],
      patch: null,
      status: "missing",
      detail: "checkpoint refs not found",
    };
  }

  const names = await git(cwd, ["diff", "--name-status", from.stdout, to.stdout]);
  if (names.code !== 0) {
    return { files: [], patch: null, status: "error", detail: names.stderr || "diff failed" };
  }

  const files: DiffFileEntry[] = [];
  for (const line of names.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [statusRaw, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    const statusChar = (statusRaw?.[0] ?? "?") as DiffFileEntry["status"];
    if (path) files.push({ path, status: ["A", "M", "D", "R"].includes(statusChar) ? statusChar : "?" });
  }

  const patch = await git(cwd, ["diff", from.stdout, to.stdout]);
  return {
    files,
    patch: patch.code === 0 ? patch.stdout || null : null,
    status: "ready",
  };
}

export interface RestoreResult {
  status: "restored" | "skipped" | "missing" | "error";
  /** Ref holding the state that was replaced, so the restore itself is undoable. */
  undoRef: string | null;
  files: DiffFileEntry[];
  detail?: string;
}

/**
 * Restores the working tree to a checkpoint.
 *
 * Destructive by nature: it overwrites whatever is in the tree now. Two things
 * make that survivable, and both are deliberate.
 *
 * The current state is captured to its own ref first, so a restore can itself
 * be undone — a checkpoint feature that can lose work is worse than none,
 * because it invites people to rely on it.
 *
 * HEAD is never moved and no commit is created. Restoring changes files only,
 * leaving branch and history exactly as the user left them.
 */
export async function restoreCheckpoint(
  cwd: string,
  ref: string,
  undoLabel: string,
): Promise<RestoreResult> {
  if (!(await isGitRepo(cwd))) {
    return { status: "skipped", undoRef: null, files: [], detail: "not a git repository" };
  }

  const target = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (target.code !== 0) {
    return { status: "missing", undoRef: null, files: [], detail: "checkpoint not found" };
  }

  // Snapshot what we are about to overwrite, before touching anything.
  const undo = await captureCheckpoint(cwd, undoLabel, "restore", "pre");
  if (undo.status === "error") {
    return {
      status: "error",
      undoRef: null,
      files: [],
      detail: `refusing to restore without a recovery point: ${undo.detail ?? "capture failed"}`,
    };
  }

  // What the restore will change, computed before it happens so the answer
  // describes the actual effect rather than the result.
  const preview = await git(cwd, ["diff", "--name-status", target.stdout]);
  const files: DiffFileEntry[] = [];
  for (const line of preview.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [statusRaw, ...rest] = line.split("\t");
    const char = (statusRaw?.[0] ?? "?") as DiffFileEntry["status"];
    const path = rest.join("\t");
    if (path) files.push({ path, status: ["A", "M", "D", "R"].includes(char) ? char : "?" });
  }

  // Materialise the checkpoint tree into the working directory without moving
  // HEAD. `checkout <tree> -- .` updates tracked paths from the checkpoint.
  const applied = await git(cwd, ["checkout", target.stdout, "--", "."]);
  if (applied.code !== 0) {
    return {
      status: "error",
      undoRef: undo.ref,
      files: [],
      detail: applied.stderr || "restore failed",
    };
  }

  // `git diff` does not list untracked files, so a file the agent created after
  // the checkpoint survives the checkout above. Remove those explicitly, or the
  // restored tree merely overlaps the checkpoint instead of matching it.
  //
  // `--exclude-standard` keeps ignored paths out of this: node_modules, .env,
  // and build output were never in the checkpoint either, and deleting them
  // would be destructive in a way the user never asked for.
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.stdout.split("\n")) {
    const name = path.trim();
    if (!name) continue;
    const inCheckpoint = await git(cwd, ["cat-file", "-e", `${target.stdout}:${name}`]);
    if (inCheckpoint.code === 0) continue;
    await rm(join(cwd, name), { force: true }).catch(() => undefined);
    if (!files.some((f) => f.path === name)) files.push({ path: name, status: "D" });
  }

  return { status: "restored", undoRef: undo.ref, files };
}
