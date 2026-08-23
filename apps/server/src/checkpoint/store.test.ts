import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCheckpoint,
  checkpointRef,
  diffCheckpoints,
  isGitRepo,
  restoreCheckpoint,
} from "./store.ts";

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(err || out || `git ${args.join(" ")} failed`);
  return out.trim();
}

describe("checkpoint store", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("non-git cwd → skipped", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-nongit-"));
    writeFileSync(join(dir, "f.txt"), "x");
    expect(await isGitRepo(dir)).toBe(false);
    const r = await captureCheckpoint(dir, "thr_1", "trn_1", "pre");
    expect(r.status).toBe("skipped");
  });

  test("git repo: pre/post refs + diff lists edited file", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-git-"));
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@divisio.local"]);
    await git(dir, ["config", "user.name", "Divisio Test"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    await git(dir, ["add", "a.txt"]);
    await git(dir, ["commit", "-m", "init"]);

    const pre = await captureCheckpoint(dir, "thr_1", "trn_1", "pre");
    expect(pre.status).toBe("ready");
    expect(pre.sha).toBeTruthy();

    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");

    const post = await captureCheckpoint(dir, "thr_1", "trn_1", "post");
    expect(post.status).toBe("ready");

    const diff = await diffCheckpoints(dir, pre.ref, post.ref);
    expect(diff.status).toBe("ready");
    const paths = diff.files.map((f) => f.path).sort();
    expect(paths).toContain("a.txt");
    expect(paths).toContain("b.txt");
    const edited = diff.files.find((f) => f.path === "a.txt");
    expect(edited?.additions).toBe(1);
    expect(edited?.deletions).toBe(1);
    const added = diff.files.find((f) => f.path === "b.txt");
    expect(added?.additions).toBe(1);
    expect(added?.deletions).toBe(0);
    expect(diff.patch).toContain("two");

    expect(checkpointRef("thr_1", "trn_1", "pre")).toContain("checkpoints/thr_1/trn_1/pre");
  });
});

/**
 * Restore overwrites the working tree, so these cover the properties that make
 * that survivable: it matches the checkpoint rather than merely overlapping it,
 * it leaves a way back, and it fails without destroying anything.
 */
describe("checkpoint restore", () => {
  let dir: string;

  async function repoWithCheckpoint(): Promise<{ ref: string }> {
    dir = mkdtempSync(join(tmpdir(), "divisio-restore-"));
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@divisio.local"]);
    await git(dir, ["config", "user.name", "Divisio Test"]);
    writeFileSync(join(dir, "app.txt"), "original\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "init"]);
    const cp = await captureCheckpoint(dir, "thr_1", "trn_1", "pre");
    expect(cp.status).toBe("ready");
    return { ref: cp.ref };
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns the tree to the checkpointed state", async () => {
    const { ref } = await repoWithCheckpoint();
    writeFileSync(join(dir, "app.txt"), "agent rewrote this\n");

    const result = await restoreCheckpoint(dir, ref, "thr_1");

    expect(result.status).toBe("restored");
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("original\n");
  });

  test("removes files created after the checkpoint", async () => {
    const { ref } = await repoWithCheckpoint();
    writeFileSync(join(dir, "stray.txt"), "created by the agent\n");

    await restoreCheckpoint(dir, ref, "thr_1");

    // Matching the checkpoint, not merely overlapping it.
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
  });

  test("captures the replaced state so the restore can itself be undone", async () => {
    const { ref } = await repoWithCheckpoint();
    writeFileSync(join(dir, "app.txt"), "work worth keeping\n");

    const restored = await restoreCheckpoint(dir, ref, "thr_1");
    expect(restored.undoRef).not.toBeNull();
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("original\n");

    // A checkpoint feature that can lose work invites people to rely on it.
    const undone = await restoreCheckpoint(dir, restored.undoRef!, "thr_1");
    expect(undone.status).toBe("restored");
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("work worth keeping\n");
  });

  test("a missing checkpoint reports rather than destroying the tree", async () => {
    await repoWithCheckpoint();
    writeFileSync(join(dir, "app.txt"), "current\n");

    const result = await restoreCheckpoint(dir, "refs/divisio/checkpoints/x/y/pre", "thr_1");

    expect(result.status).toBe("missing");
    expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe("current\n");
  });

  test("does not move HEAD", async () => {
    const { ref } = await repoWithCheckpoint();
    const before = await git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "app.txt"), "changed\n");

    await restoreCheckpoint(dir, ref, "thr_1");

    // Restoring changes files; branch and history stay where the user left them.
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(before);
  });

  test("a non-git directory is skipped, not failed", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-restore-nongit-"));
    const result = await restoreCheckpoint(dir, "refs/whatever", "thr_1");
    expect(result.status).toBe("skipped");
  });
});
