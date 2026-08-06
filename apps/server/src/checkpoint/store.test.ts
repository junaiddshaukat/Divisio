import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCheckpoint, checkpointRef, diffCheckpoints, isGitRepo } from "./store.ts";

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
    expect(diff.patch).toContain("two");

    expect(checkpointRef("thr_1", "trn_1", "pre")).toContain("checkpoints/thr_1/trn_1/pre");
  });
});
