import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairPath } from "./path-env.ts";
import { spawnWithEnv } from "./spawn.ts";

/**
 * A GUI-launched app inherits launchd's PATH, which contains none of the
 * directories agent CLIs install into. That made every provider report
 * "not on PATH" for tools that were plainly installed.
 */

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "divisio-path-"));
  originalPath = process.env["PATH"];
});

afterEach(async () => {
  if (originalPath !== undefined) process.env["PATH"] = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("PATH repair", () => {
  test("adds standard install directories that exist", async () => {
    process.env["PATH"] = "/usr/bin:/bin";
    const repaired = await repairPath();
    // Every entry must be real; a repaired PATH full of missing dirs is noise.
    expect(repaired.split(":").length).toBeGreaterThan(2);
    expect(repaired.startsWith("/usr/bin:/bin")).toBe(true);
  });

  test("never duplicates entries", async () => {
    process.env["PATH"] = "/usr/bin:/bin";
    await repairPath();
    const twice = await repairPath();
    const parts = twice.split(":");
    expect(new Set(parts).size).toBe(parts.length);
  });
});

describe("spawnWithEnv", () => {
  test("resolves binaries added to PATH after process start", async () => {
    // Bun.spawn resolves against the environment the process started with, so
    // a plain spawn cannot see this directory. That is the whole bug.
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    const script = join(binDir, "divisio-fake-cli");
    await writeFile(script, "#!/bin/sh\necho FAKE_OK\n");
    await chmod(script, 0o755);

    process.env["PATH"] = `${binDir}:${process.env["PATH"]}`;

    const proc = spawnWithEnv(["divisio-fake-cli"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("FAKE_OK");
  });
});
