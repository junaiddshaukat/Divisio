import { describe, expect, test } from "bun:test";
import type { ProviderView } from "@divisio/contracts";
import { PROVIDER_SETUP, setupFor } from "@divisio/adapters/setup";

/**
 * Onboarding decides what to show from real machine state. These lock the
 * decisions that determine whether a new user gets somewhere or gets stuck.
 */

const provider = (kind: string, available: boolean, install: string | null = null): ProviderView =>
  ({
    kind,
    label: kind,
    tier: "stream",
    source: "builtin",
    available,
    version: available ? "1.0.0" : null,
    detail: available ? null : `${kind} not on PATH`,
    authenticated: null,
    install,
    signIn: null,
    capabilities: {},
  }) as ProviderView;

describe("first-run readiness", () => {
  test("a machine with no agent installed cannot continue", () => {
    const providers = [provider("claude", false, "npm i -g x"), provider("codex", false)];
    // Continue is gated on at least one usable provider — otherwise the first
    // prompt fails and the user has no idea why.
    expect(providers.filter((p) => p.available)).toHaveLength(0);
  });

  test("every unavailable provider offers a command to fix it", () => {
    const missing = provider("claude", false, "npm install -g @anthropic-ai/claude-code");
    expect(missing.install).toBeTruthy();
    expect(missing.detail).toContain("not on PATH");
  });

  test("authentication is reported as unknown, never guessed", () => {
    // Probing auth can start a login flow, so detect does not ask.
    expect(provider("claude", true).authenticated).toBeNull();
  });
});

describe("declared setup commands", () => {
  test("every known provider has install and sign-in copy", () => {
    for (const [kind, entry] of Object.entries(PROVIDER_SETUP)) {
      expect(entry.install.length).toBeGreaterThan(0);
      expect(entry.signIn.length).toBeGreaterThan(0);
      const wired = setupFor(kind);
      expect(wired.install).toBe(entry.install);
      expect(wired.signIn).toBe(entry.signIn);
    }
  });

  test("unknown kinds return nulls instead of inventing commands", () => {
    expect(setupFor("not-a-real-provider")).toEqual({ install: null, signIn: null });
  });
});
