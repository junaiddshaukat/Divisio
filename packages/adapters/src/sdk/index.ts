/**
 * Divisio Adapter SDK — Phase 4 entry for community providers.
 *
 * Implement `ProviderAdapter` from `@divisio/contracts`, export
 * `createAdapter()` / `createAdapters()`, and load via
 * `DIVISIO_ADAPTER_MODULES` or `~/…/userdata/adapters.json`.
 *
 * See docs/sdk/adapter-sdk.md for the full guide.
 */

export type {
  AdapterCapabilities,
  AdapterSource,
  AdapterTier,
  DetectResult,
  EmitRuntimeEvent,
  ModelCatalog,
  ModelCatalogSource,
  ModelOption,
  ProviderAdapter,
  ProviderKind,
  ProviderRuntimeEvent,
  SendTurnInput,
  SessionHandle,
  StartSessionInput,
} from "@divisio/contracts";

export { ADAPTER_CONTRACT_VERSION } from "@divisio/contracts";

export { AdapterRegistry } from "../registry.ts";
export type { RegisteredAdapter } from "../registry.ts";
export { loadCommunityAdapters, readAdaptersConfig, defaultAdaptersConfigPath } from "../community/load.ts";
export type { CommunityAdaptersConfig, LoadCommunityOptions } from "../community/load.ts";
export { detectCli, interruptProcess } from "../shared/streamPump.ts";
export type { TurnProcess } from "../shared/streamPump.ts";
export { replayFixtureFile, replayNdjson, splitNdjson } from "../testkit/replay.ts";
export type { ReplayResult, StreamNormalizer } from "../testkit/replay.ts";

/**
 * Skeleton for a stream-tier adapter. Copy into your package and fill in
 * detect / startSession / line→event mapping. Prefer Structured when the
 * vendor has JSON-RPC; use PTY only as a last resort.
 */
export const STREAM_ADAPTER_TEMPLATE = `
import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type DetectResult,
  type EmitRuntimeEvent,
  type ProviderAdapter,
  type SendTurnInput,
  type SessionHandle,
  type StartSessionInput,
} from "@divisio/contracts";

const capabilities: AdapterCapabilities = {
  sessionResume: false,
  interruptTurn: true,
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

export class ExampleStreamAdapter implements ProviderAdapter {
  readonly kind = "example";
  readonly label = "Example CLI";
  readonly tier = "stream" as const;
  readonly capabilities = capabilities;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  async detect(): Promise<DetectResult> {
    // Check PATH / --version; never invent auth.
    return { available: false, version: null, detail: "example CLI not on PATH" };
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    emit({ type: "status", status: "ready" });
    return {
      threadId: input.threadId,
      nativeId: null,
      close: async () => undefined,
    };
  }

  async sendTurn(session: SessionHandle, turn: SendTurnInput): Promise<void> {
    void session;
    void turn;
    throw new Error("not implemented — map CLI NDJSON → ProviderRuntimeEvent");
  }

  async interruptTurn(session: SessionHandle, turnId: string): Promise<void> {
    void session;
    void turnId;
  }

  async stopSession(session: SessionHandle): Promise<void> {
    await session.close();
  }
}

/** Community packages must export a factory Divisio can dynamic-import. */
export function createAdapter(): ProviderAdapter {
  return new ExampleStreamAdapter();
}
`.trim();
