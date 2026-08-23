import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCliUpdates,
  extractInstalledVersion,
  isNewer,
  parseSemver,
  updatesFromVersions,
  upgradeCommand,
} from "./cliUpdates.ts";

describe("parseSemver", () => {
  test("strips v and takes the numeric core", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("2.0.0-beta.1")).toEqual([2, 0, 0]);
  });

  test("rejects non-versions", () => {
    expect(parseSemver("test")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("isNewer", () => {
  test("only reports a strictly greater latest", () => {
    expect(isNewer("2.1.0", "2.0.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "2.0.0")).toBe(false);
    expect(isNewer("nope", "1.0.0")).toBe(false);
  });
});

describe("extractInstalledVersion", () => {
  test("finds the first semver in CLI --version output", () => {
    expect(extractInstalledVersion("2.1.4 (Claude Code)")).toBe("2.1.4");
    expect(extractInstalledVersion("opencode 1.0.12")).toBe("1.0.12");
  });
});

describe("updatesFromVersions", () => {
  test("emits a row only when npm latest is newer", () => {
    const rows = updatesFromVersions(
      [
        { kind: "claude", label: "Claude Code", available: true, version: "1.0.0" },
        { kind: "codex", label: "Codex", available: true, version: "3.0.0" },
        { kind: "cursor", label: "Cursor", available: true, version: "1.0.0" },
        { kind: "grok", label: "Grok", available: false, version: "0.1.0" },
      ],
      {
        "@anthropic-ai/claude-code": "1.1.0",
        "@openai/codex": "3.0.0",
      },
    );
    expect(rows).toEqual([
      {
        kind: "claude",
        label: "Claude Code",
        installed: "1.0.0",
        latest: "1.1.0",
        command: "npm install -g @anthropic-ai/claude-code@latest",
      },
    ]);
  });

  test("opencode upgrade copies the documented installer, not an invented npm path", () => {
    expect(upgradeCommand("opencode", "opencode-ai")).toContain("opencode.ai/install");
  });
});

describe("collectCliUpdates", () => {
  test("uses the injected lookup and writes a cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "divisio-cli-up-"));
    try {
      const first = await collectCliUpdates(
        [{ kind: "gemini", label: "Gemini CLI", available: true, version: "0.1.0" }],
        {
          cacheDir: dir,
          lookup: async (pkg) => (pkg === "@google/gemini-cli" ? "0.2.0" : null),
        },
      );
      expect(first[0]?.latest).toBe("0.2.0");

      let lookups = 0;
      const second = await collectCliUpdates(
        [{ kind: "gemini", label: "Gemini CLI", available: true, version: "0.1.0" }],
        {
          cacheDir: dir,
          lookup: async () => {
            lookups += 1;
            return "9.9.9";
          },
        },
      );
      expect(lookups).toBe(0);
      expect(second[0]?.latest).toBe("0.2.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
