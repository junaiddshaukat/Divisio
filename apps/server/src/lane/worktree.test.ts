import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateBranch,
  allocatePort,
  copyCarryOver,
  createWorktree,
  isDirty,
  isGitRepo,
  loadLaneConfig,
  removeWorktree,
} from "./worktree.ts";

/**
 * These cover the guarantees the spec is built on. The git plumbing is easy;
 * what matters is that a lane never writes back into the primary checkout and
 * that archiving cannot silently destroy work.
 */

let dir: string;
let primary: string;

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "divisio-lane-"));
  primary = join(dir, "primary");
  await mkdir(primary, { recursive: true });
  await git(primary, ["init", "-q", "."]);
  await git(primary, ["config", "user.email", "test@example.com"]);
  await git(primary, ["config", "user.name", "test"]);
  await writeFile(join(primary, "app.txt"), "original\n");
  await git(primary, ["add", "-A"]);
  await git(primary, ["commit", "-qm", "init"]);
  process.env["DIVISIO_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["DIVISIO_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("lane worktrees", () => {
  test("a lane is a real worktree isolated from the primary checkout", async () => {
    const branch = await allocateBranch(primary, "Add search");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");

    expect(created.branch).toBe("divisio/add-search");
    expect(await isGitRepo(created.root)).toBe(true);

    // Editing in the lane must leave the primary checkout untouched.
    await writeFile(join(created.root, "app.txt"), "changed by agent\n");
    expect(await readFile(join(primary, "app.txt"), "utf8")).toBe("original\n");
    expect(await isDirty(created.root)).toBe(true);
    expect(await isDirty(primary)).toBe(false);
  });

  test("lanes live outside the repository", async () => {
    const branch = await allocateBranch(primary, "outside");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    expect(created.root.startsWith(primary)).toBe(false);
  });

  test("branch names never silently reuse an existing branch", async () => {
    const first = await allocateBranch(primary, "Same title");
    await createWorktree(primary, "prj_1", "lane_1", first, "HEAD");
    const second = await allocateBranch(primary, "Same title");
    expect(second).not.toBe(first);
    expect(second).toBe("divisio/same-title-2");
  });

  test("git refuses the same branch in two lanes", async () => {
    const branch = await allocateBranch(primary, "dup");
    await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    await expect(createWorktree(primary, "prj_1", "lane_2", branch, "HEAD")).rejects.toThrow();
  });
});

describe("carry-over", () => {
  test("copies untracked files the worktree would not contain", async () => {
    await writeFile(join(primary, ".env"), "SECRET=1\n");
    const branch = await allocateBranch(primary, "carry");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");

    // A fresh worktree has tracked files only.
    expect(existsSync(join(created.root, ".env"))).toBe(false);

    const result = await copyCarryOver(primary, created.root, [".env"]);
    expect(result.copied).toContain(".env");
    expect(await readFile(join(created.root, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  test("writing a carried file in the lane does not reach the primary checkout", async () => {
    await writeFile(join(primary, ".env"), "SECRET=original\n");
    const branch = await allocateBranch(primary, "nowrite");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    await copyCarryOver(primary, created.root, [".env"]);

    await writeFile(join(created.root, ".env"), "SECRET=rewritten-by-agent\n");

    // The whole point of copying rather than symlinking.
    expect(await readFile(join(primary, ".env"), "utf8")).toBe("SECRET=original\n");
  });

  test("a symlinked source is copied by content, not as a link", async () => {
    await writeFile(join(dir, "outside-secret"), "OUTSIDE=1\n");
    await symlink(join(dir, "outside-secret"), join(primary, ".env"));
    const branch = await allocateBranch(primary, "deref");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    await copyCarryOver(primary, created.root, [".env"]);

    const info = await stat(join(created.root, ".env"));
    expect(info.isSymbolicLink()).toBe(false);

    // Writing through must not reach the original target either.
    await writeFile(join(created.root, ".env"), "OUTSIDE=changed\n");
    expect(await readFile(join(dir, "outside-secret"), "utf8")).toBe("OUTSIDE=1\n");
  });

  test("refuses entries escaping the project and never copies node_modules", async () => {
    const branch = await allocateBranch(primary, "escape");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    await mkdir(join(primary, "node_modules"), { recursive: true });
    await writeFile(join(primary, "node_modules", "big.txt"), "x");

    const result = await copyCarryOver(primary, created.root, ["../outside-secret", "/etc/hosts", "node_modules"]);

    expect(result.copied).toHaveLength(0);
    expect(existsSync(join(created.root, "node_modules"))).toBe(false);
  });
});

describe("archive safety", () => {
  test("a dirty lane is not removed without force", async () => {
    const branch = await allocateBranch(primary, "dirty");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    await writeFile(join(created.root, "app.txt"), "uncommitted work\n");

    await expect(removeWorktree(primary, created.root, branch, false, false)).rejects.toThrow();
    expect(existsSync(created.root)).toBe(true);
  });

  test("force removes the lane and can delete its branch", async () => {
    const branch = await allocateBranch(primary, "forced");
    const created = await createWorktree(primary, "prj_1", "lane_1", branch, "HEAD");
    await writeFile(join(created.root, "app.txt"), "uncommitted\n");

    await removeWorktree(primary, created.root, branch, true, true);
    expect(existsSync(created.root)).toBe(false);
    expect(await git(primary, ["branch", "--list", branch])).toBe("");
  });
});

describe("ports and config", () => {
  test("allocation skips ports already held by a lane", () => {
    const first = allocatePort(new Set());
    const second = allocatePort(new Set([first]));
    expect(second).not.toBe(first);
  });

  test("config falls back to defaults when absent", async () => {
    const config = await loadLaneConfig(primary);
    expect(config.carryOver).toContain(".env");
    expect(config.setup).toBeNull();
  });

  test("config is read from the project when present", async () => {
    await mkdir(join(primary, ".divisio"), { recursive: true });
    await writeFile(
      join(primary, ".divisio", "project.json"),
      JSON.stringify({ lane: { carryOver: [".env.test"], setup: "echo hi", portEnv: ["APP_PORT"] } }),
    );
    const config = await loadLaneConfig(primary);
    expect(config.carryOver).toEqual([".env.test"]);
    expect(config.setup).toBe("echo hi");
    expect(config.portEnv).toEqual(["APP_PORT"]);
  });
});
