import { describe, expect, test } from "bun:test";
import { claudeTurnArgs } from "./claude.ts";

describe("claudeTurnArgs", () => {
  test("allowlists WebSearch in print mode under both permission modes", () => {
    const supervised = claudeTurnArgs({
      text: "research this",
      nativeId: null,
      permissionMode: "supervised",
    });
    expect(supervised).toContain("--print");
    expect(supervised).toContain("--permission-mode");
    expect(supervised).toContain("manual");
    const allow = supervised.find((a) => a.startsWith("--allowedTools="));
    expect(allow).toBeDefined();
    expect(allow).toContain("WebSearch");
    expect(allow).toContain("WebFetch");
    // Variadic `--allowedTools WebSearch,WebFetch <prompt>` eats the prompt.
    expect(supervised).not.toContain("--allowedTools");
    expect(supervised.at(-2)).toBe("--");
    expect(supervised.at(-1)).toBe("research this");

    const full = claudeTurnArgs({
      text: "edit files",
      nativeId: "ses_1",
      permissionMode: "full_access",
      model: "opus",
    });
    expect(full).toContain("acceptEdits");
    expect(full).not.toContain("bypassPermissions");
    expect(full).toContain("--resume");
    expect(full).toContain("ses_1");
    expect(full.find((a) => a.startsWith("--allowedTools="))).toContain("WebSearch");
    expect(full.at(-1)).toBe("edit files");
  });
});
