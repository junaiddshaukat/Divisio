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
