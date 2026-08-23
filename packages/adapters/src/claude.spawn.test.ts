import { describe, expect, test } from "bun:test";
import { claudeSessionArgs } from "./claude.ts";

describe("claudeSessionArgs", () => {
  test("drives a reusable stream-json session, not a one-shot prompt", () => {
    const args = claudeSessionArgs({ nativeId: null, permissionMode: "supervised" });
    // stream-json stdin is what lets one process serve many turns.
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--print");
    // The prompt must never be baked into argv — it arrives on stdin.
    expect(args.at(-1)).not.toBe("--");
    expect(args).not.toContain("--");
  });

  test("allowlists WebSearch in print mode under both permission modes", () => {
    const supervised = claudeSessionArgs({ nativeId: null, permissionMode: "supervised" });
    expect(supervised).toContain("--permission-mode");
    expect(supervised).toContain("manual");
    const allow = supervised.find((a) => a.startsWith("--allowedTools="));
    expect(allow).toBeDefined();
    expect(allow).toContain("WebSearch");
    expect(allow).toContain("WebFetch");
    // Variadic `--allowedTools WebSearch,WebFetch` would eat the next token.
    expect(supervised).not.toContain("--allowedTools");

    const full = claudeSessionArgs({
      nativeId: "ses_1",
      permissionMode: "full_access",
      model: "opus",
    });
    expect(full).toContain("acceptEdits");
    expect(full).not.toContain("bypassPermissions");
    expect(full).toContain("--resume");
    expect(full).toContain("ses_1");
    expect(full).toContain("--model");
    expect(full).toContain("opus");
  });
});
