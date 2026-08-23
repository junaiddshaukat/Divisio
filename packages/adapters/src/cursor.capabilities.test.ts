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
  /** Stand in for the agent having asked permission at least once. */
  const withMediation = (adapter: CursorAdapter) => {
    (adapter as unknown as { acp: { mediationObserved: boolean } }).acp.mediationObserved = true;
  };

  test("claims nothing before the transport has been probed", () => {
    const adapter = new CursorAdapter();
    expect(adapter.capabilities.approvals).toBe(false);
    expect(adapter.tier).toBe("stream");
  });

  test("declares mediated approvals only when the transport is up and the agent asks", () => {
    const adapter = new CursorAdapter();
    setProbeResult(adapter, true);
    // Transport alone is not evidence the agent will ever ask.
    expect(adapter.capabilities.approvals).toBe(false);
    withMediation(adapter);
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
    withMediation(adapter);
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
 * Approvals are claimed from evidence, not from the transport. An agent that
 * runs its tools without asking must not present a supervision control, or the
 * user believes they are supervising something they are not.
 */
describe("approval mediation is earned, not assumed", () => {
  const warm = (adapter: { acp: unknown }) => {
    (adapter.acp as { supported: boolean | null }).supported = true;
  };
  const observeRequest = (adapter: { acp: unknown }) => {
    (adapter.acp as { mediationObserved: boolean }).mediationObserved = true;
  };

  test("a warm agent that has never asked declares no approvals", async () => {
    const { GrokAdapter } = await import("./grok.ts");
    const grok = new GrokAdapter();
    warm(grok as unknown as { acp: unknown });
    // Warm transport, so the structured tier is right...
    expect(grok.tier).toBe("structured");
    // ...but nothing has asked, so supervision would be a fiction.
    expect(grok.capabilities.approvals).toBe(false);
  });

  test("approvals are declared once the agent has actually asked", () => {
    const cursor = new CursorAdapter();
    warm(cursor as unknown as { acp: unknown });
    expect(cursor.capabilities.approvals).toBe(false);

    observeRequest(cursor as unknown as { acp: unknown });
    expect(cursor.capabilities.approvals).toBe(true);
  });

  test("having asked is not enough without a working transport", () => {
    const cursor = new CursorAdapter();
    observeRequest(cursor as unknown as { acp: unknown });
    // The transport never came up, so there is nothing to answer through.
    expect(cursor.capabilities.approvals).toBe(false);
  });
});
