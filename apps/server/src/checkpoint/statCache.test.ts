/**
 * The checkpoint index is seeded from the live `.git/index` so `git add -A`
 * keeps git's stat cache instead of re-hashing the whole worktree. That is only
 * safe if it produces exactly the tree the old `read-tree HEAD` seed produced.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCheckpoint } from "./store.ts";

const dirs: string[] = [];

function sh(cwd: string, args: string[]): string {
  const p = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(p.stdout).trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "divisio-statcache-"));
  dirs.push(dir);
  sh(dir, ["git", "init", "-q", "."]);
  sh(dir, ["git", "config", "user.email", "t@t"]);
  sh(dir, ["git", "config", "user.name", "t"]);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("checkpoint index seeding", () => {
  test("captures modifications, additions and deletions identically to read-tree", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "sub", "b.txt"), "b\n");
    writeFileSync(join(dir, "gone.txt"), "gone\n");
    sh(dir, ["git", "add", "-A"]);
    sh(dir, ["git", "commit", "-qm", "init"]);

    // Every kind of worktree change at once.
    writeFileSync(join(dir, "a.txt"), "modified\n");
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    unlinkSync(join(dir, "gone.txt"));
    mkdirSync(join(dir, "deep", "er"), { recursive: true });
    writeFileSync(join(dir, "deep", "er", "x.txt"), "x\n");

    const captured = await captureCheckpoint(dir, "thr", "trn", "pre");
    expect(captured.status).toBe("ready");
    expect(captured.sha).toBeTruthy();

    // Reference tree built the old way, in a throwaway index.
    const refIndex = join(mkdtempSync(join(tmpdir(), "divisio-ref-")), "index");
    const env = { ...process.env, GIT_INDEX_FILE: refIndex };
    Bun.spawnSync({ cmd: ["git", "read-tree", "HEAD"], cwd: dir, env });
    Bun.spawnSync({ cmd: ["git", "add", "-A"], cwd: dir, env });
    const expected = new TextDecoder()
      .decode(Bun.spawnSync({ cmd: ["git", "write-tree"], cwd: dir, env, stdout: "pipe" }).stdout)
      .trim();

    const actual = sh(dir, ["git", "rev-parse", `${captured.sha}^{tree}`]);
    expect(actual).toBe(expected);
  });

  test("does not disturb the user's own index", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, ["git", "add", "-A"]);
    sh(dir, ["git", "commit", "-qm", "init"]);
    writeFileSync(join(dir, "a.txt"), "changed\n");

    const before = statSync(join(dir, ".git", "index")).mtimeMs;
    await captureCheckpoint(dir, "thr", "trn", "pre");
    expect(statSync(join(dir, ".git", "index")).mtimeMs).toBe(before);
    // The user's staged state is untouched: a.txt is modified but NOT staged.
    // `sh` trims, so compare on the raw porcelain line.
    const status = new TextDecoder()
      .decode(
        Bun.spawnSync({ cmd: ["git", "status", "--porcelain"], cwd: dir, stdout: "pipe" }).stdout,
      )
      .replace(/\n$/, "");
    expect(status).toBe(" M a.txt");
  });

  test("skipIfExists short-circuits a repeated capture to the same ref", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, ["git", "add", "-A"]);
    sh(dir, ["git", "commit", "-qm", "init"]);

    const first = await captureCheckpoint(dir, "thr", "trn", "pre");
    writeFileSync(join(dir, "a.txt"), "changed after the first capture\n");
    const second = await captureCheckpoint(dir, "thr", "trn", "pre", { skipIfExists: true });

    // Same ref, so the pre-turn baseline must not drift to the newer content.
    expect(second.sha).toBe(first.sha);
    expect(second.status).toBe("ready");
  });

  test("concurrent captures of one ref are coalesced into a single commit", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, ["git", "add", "-A"]);
    sh(dir, ["git", "commit", "-qm", "init"]);
    writeFileSync(join(dir, "b.txt"), "b\n");

    const [x, y, z] = await Promise.all([
      captureCheckpoint(dir, "thr", "trn", "pre"),
      captureCheckpoint(dir, "thr", "trn", "pre"),
      captureCheckpoint(dir, "thr", "trn", "pre"),
    ]);
    expect(x.sha).toBe(y.sha);
    expect(y.sha).toBe(z.sha);
  });

  test("a non-git directory still reports skipped, not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "divisio-nogit-"));
    dirs.push(dir);
    const r = await captureCheckpoint(dir, "thr", "trn", "pre");
    expect(r.status).toBe("skipped");
  });
});
