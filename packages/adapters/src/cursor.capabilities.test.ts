import { describe, expect, test } from "bun:test";
import { CursorAdapter } from "./cursor.ts";

/**
 * Capabilities must describe the transport actually in use. Declaring
 * `approvals` while running a transport that cannot mediate them puts an
 * approve/deny control in the UI that decides nothing.
 */
describe("cursor capability honesty", () => {
  const setProbeResult = (adapter: CursorAdapter, supported: boolean | null) => {
    (adapter as unknown as { acp: { supported: boolean | null } }).acp.supported = supported;
  };

  test("claims nothing before the transport has been probed", () => {
    const adapter = new CursorAdapter();
    expect(adapter.capabilities.approvals).toBe(false);
    expect(adapter.tier).toBe("stream");
  });

  test("declares mediated approvals only when the protocol transport is available", () => {
    const adapter = new CursorAdapter();
    setProbeResult(adapter, true);
    expect(adapter.capabilities.approvals).toBe(true);
    expect(adapter.tier).toBe("structured");
  });

  test("falls back to the streaming tier when the probe fails", () => {
    const adapter = new CursorAdapter();
    setProbeResult(adapter, false);
    expect(adapter.capabilities.approvals).toBe(false);
    expect(adapter.tier).toBe("stream");
  });

  test("capabilities are a fresh object, so a caller cannot mutate the adapter", () => {
    const adapter = new CursorAdapter();
    setProbeResult(adapter, true);
    const caps = adapter.capabilities;
    caps.approvals = false;
    expect(adapter.capabilities.approvals).toBe(true);
  });

  test("non-transport capabilities are unchanged by the probe", () => {
    const adapter = new CursorAdapter();
    setProbeResult(adapter, true);
    expect(adapter.capabilities.sessionResume).toBe(true);
    expect(adapter.capabilities.worktreeAware).toBe(true);
    expect(adapter.capabilities.usageSignals).toBe(false);
  });
});

/**
 * The protocol transport buys a warm session for every agent that speaks it,
 * but supervision only where the agent actually asks before acting. An agent
 * that runs its tools regardless must not present a supervised/full-access
 * control, or the user believes they are supervising something they are not.
 */
describe("approval mediation is claimed per agent, not per transport", () => {
  const force = (adapter: { acp: unknown }, supported: boolean) => {
    (adapter.acp as { supported: boolean | null }).supported = supported;
  };

  test("an agent known to auto-approve declares no approvals even when warm", async () => {
    const { GrokAdapter } = await import("./grok.ts");
    const grok = new GrokAdapter();
    force(grok as unknown as { acp: unknown }, true);
    // Warm transport, so the structured tier is right...
    expect(grok.tier).toBe("structured");
    // ...but it never asks, so supervision would be a fiction.
    expect(grok.capabilities.approvals).toBe(false);
  });

  test("an agent that routes tools through the permission request declares them", () => {
    const cursor = new CursorAdapter();
    force(cursor as unknown as { acp: unknown }, true);
    expect(cursor.tier).toBe("structured");
    expect(cursor.capabilities.approvals).toBe(true);
  });
});
