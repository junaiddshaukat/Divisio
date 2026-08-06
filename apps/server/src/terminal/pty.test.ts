import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSpawnHelperExecutable, terminalsAvailable } from "./pty.ts";

/**
 * node-pty exec's a `spawn-helper` binary to allocate the pty. Some package
 * managers extract it without the executable bit, and the resulting failure is
 * a bare "posix_spawnp failed" that says nothing about the cause. Repairing it
 * at startup is cheaper than every user debugging that message.
 */

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("spawn-helper repair", () => {
  test("adds the executable bit when it is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-pty-"));
    const platformDir = join(dir, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(platformDir, { recursive: true });
    const helper = join(platformDir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, 0o644);

    expect(statSync(helper).mode & 0o111).toBe(0);
    ensureSpawnHelperExecutable(dir);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });

  test("leaves an already-executable helper alone", () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-pty-"));
    const platformDir = join(dir, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(platformDir, { recursive: true });
    const helper = join(platformDir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, 0o755);

    ensureSpawnHelperExecutable(dir);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });

  test("a missing helper is not an error", () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-pty-"));
    expect(() => ensureSpawnHelperExecutable(dir)).not.toThrow();
  });
});

describe("availability", () => {
  test("reports whether terminals can run, without throwing", () => {
    // A terminal is a feature, not a dependency: failing to load node-pty must
    // never take the daemon down.
    expect(typeof terminalsAvailable()).toBe("boolean");
  });
});
