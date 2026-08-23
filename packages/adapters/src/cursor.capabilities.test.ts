import { describe, expect, test } from "bun:test";
import { CursorAdapter } from "./cursor.ts";

/**
 * Capabilities must describe the transport actually in use. Declaring
 * `approvals` while running a transport that cannot mediate them puts an
 * approve/deny control in the UI that decides nothing.
 */
describe("cursor capability honesty", () => {
  const setProbeResult = (adapter: CursorAdapter, supported: boolean | null) => {
    (adapter as unknown as { acpSupported: boolean | null }).acpSupported = supported;
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
