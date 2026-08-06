/**
 * Fixture community module for loader tests (no workspace imports).
 * Contract version must match ADAPTER_CONTRACT_VERSION.
 */
export function createAdapter() {
  const caps = {
    sessionResume: false,
    interruptTurn: true,
    modelSwitch: false,
    approvals: false,
    handoffExport: false,
    worktreeAware: true,
    usageSignals: false,
  };
  return {
    kind: "stub-from-file",
    label: "Stub From File",
    tier: "stream" as const,
    capabilities: caps,
    contractVersion: 1,
    async detect() {
      return { available: true, version: "1", detail: null };
    },
    async startSession(input: { threadId: string }, emit: (e: { type: string; status?: string }) => void) {
      emit({ type: "status", status: "ready" });
      return { threadId: input.threadId, nativeId: null, close: async () => undefined };
    },
    async sendTurn() {},
    async interruptTurn() {},
    async stopSession(s: { close(): Promise<void> }) {
      await s.close();
    },
  };
}
