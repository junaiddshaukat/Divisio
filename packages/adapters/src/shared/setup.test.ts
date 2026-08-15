import { describe, expect, test } from "bun:test";
import { PROVIDER_SETUP, setupFor } from "./setup.ts";

describe("PROVIDER_SETUP", () => {
  test("setupFor returns declared install and sign-in", () => {
    expect(setupFor("claude").install).toContain("claude-code");
    expect(setupFor("codex").signIn).toBe("codex login");
    expect(setupFor("cursor").signIn).toBe("cursor-agent login");
  });

  test("every entry is non-empty", () => {
    for (const entry of Object.values(PROVIDER_SETUP)) {
      expect(entry.install.trim().length).toBeGreaterThan(0);
      expect(entry.signIn.trim().length).toBeGreaterThan(0);
    }
  });
});
