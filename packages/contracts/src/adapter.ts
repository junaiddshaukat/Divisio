/**
 * The provider adapter contract — the only place vendor CLI differences live.
 *
 * This is also the public SDK surface. First-party adapters get no privileged
 * access beyond what is declared here; if they did, the community SDK would be
 * a Phase 4 retrofit that does not fit.
 */

import type { PermissionMode, SessionStatus } from "./events.ts";

export type ProviderKind = string;

export type AdapterTier = "structured" | "stream" | "pty";

/**
 * Declared honestly or not at all. Unknown means unsupported.
 * The UI renders this matrix instead of guessing, so a false claim here
 * becomes a broken button rather than a graceful degradation.
 */
export interface AdapterCapabilities {
  sessionResume: boolean;
  interruptTurn: boolean;
  modelSwitch: boolean;
  approvals: boolean;
  handoffExport: boolean;
  worktreeAware: boolean;
  /** True only when this adapter maps vendor token counts onto `usage.reported`. */
  usageSignals: boolean;
}

/**
 * One model the CLI will accept as `--model` (or equivalent).
 * `id` is the argv slug; `label` is what the picker shows.
 */
export interface ModelOption {
  id: string;
  label: string;
  /** When true, omit the model flag and let the CLI choose. */
  isDefault?: boolean;
}

/**
 * `live` means the adapter read the vendor CLI’s own catalog (settings,
 * cache, or a side-effect-free list command). `none` means we have nothing
 * honest to show — the UI may fall back to a curated alias list.
 */
export type ModelCatalogSource = "live" | "none";

export interface ModelCatalog {
  source: ModelCatalogSource;
  models: ModelOption[];
  /** Vendor’s currently selected model id, when the CLI config names one. */
  selectedId?: string | null;
}

export interface DetectResult {
  /** The binary is on PATH and runs. Says nothing about whether it can work. */
  available: boolean;
  /** Reported CLI version. Vendor CLIs change often; features gate on this. */
  version: string | null;
  /** Actionable when unavailable, e.g. "codex not on PATH" or "run claude auth login". */
  detail: string | null;
  /**
   * Whether the CLI is signed in.
   *
   * `null` means the CLI offers no way to ask without starting a turn — an
   * honest "unknown" rather than a guess. Installed-but-unauthenticated is the
   * most common first-run failure, and reporting it as ready produces a
   * confusing error on the user's very first prompt instead of a fixable one.
   */
  authenticated?: boolean | null;
  /** Shell command that installs this CLI, for onboarding to offer directly. */
  install?: string | null;
  /** Shell command that signs the user in. */
  signIn?: string | null;
}

export interface StartSessionInput {
  threadId: string;
  cwd: string;
  /** Vendor-native session id to resume. Only meaningful if sessionResume. */
  resumeId?: string;
  /**
   * Divisio permission mode for this session. Adapters that mediate approvals
   * honor it; stream-tier print modes ignore it (CLI owns permissions).
   */
  permissionMode?: PermissionMode;
}

export interface SessionHandle {
  threadId: string;
  /** Vendor-native session id, when the provider exposes one. */
  nativeId: string | null;
  close(): Promise<void>;
}

export interface SendTurnInput {
  turnId: string;
  text: string;
  /** Vendor model slug when the adapter declares modelSwitch / accepts --model. */
  model?: string;
}

/** Normalized runtime events. Adapters translate; orchestration never branches on vendor. */
export type ProviderRuntimeEvent =
  | { type: "assistant.delta"; turnId: string; text: string }
  | { type: "assistant.message"; turnId: string; text: string }
  | { type: "tool.started"; turnId: string; toolCallId: string; name: string; input?: string }
  | { type: "tool.finished"; turnId: string; toolCallId: string; ok: boolean; output?: string }
  | { type: "approval.requested"; turnId: string; approvalId: string; category: string; summary: string }
  | { type: "turn.completed"; turnId: string }
  | {
      type: "usage.reported";
      turnId: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      /** Cache hits. Disjoint from `inputTokens` on Claude's wire. */
      cacheReadTokens?: number;
      /** Cache writes. Disjoint from `inputTokens` on Claude's wire. */
      cacheWriteTokens?: number;
    }
  | { type: "status"; status: SessionStatus; detail?: string }
  | { type: "session.exited"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message: string };

export type EmitRuntimeEvent = (event: ProviderRuntimeEvent) => void;

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly tier: AdapterTier;
  readonly capabilities: AdapterCapabilities;
  /** Contract version this adapter targets. Checked before load. */
  readonly contractVersion: number;

  detect(): Promise<DetectResult>;

  /**
   * Optional. Returns models this CLI actually has configured or cached.
   * Must be side-effect-free: no login flows, no network that starts auth.
   * Secrets in vendor config files must never appear in the result.
   */
  listModels?(): Promise<ModelCatalog>;

  /**
   * Starts a session. `emit` is passed IN rather than attached afterwards —
   * a separate subscribe() call loses every event between spawn and subscribe.
   */
  startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle>;

  sendTurn(session: SessionHandle, turn: SendTurnInput): Promise<void>;

  /** Takes an explicit turnId. There is no implicit "current turn". */
  interruptTurn(session: SessionHandle, turnId: string): Promise<void>;

  respondToApproval?(
    session: SessionHandle,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void>;

  /**
   * Optional. Applies a permission-mode change to a *live* session.
   *
   * Adapters that bake the mode into spawn argv cannot honor this, so the
   * orchestrator falls back to restarting the session. Declaring it means the
   * running process is reconfigured without losing conversation state.
   */
  setPermissionMode?(session: SessionHandle, mode: PermissionMode): void | Promise<void>;

  stopSession(session: SessionHandle): Promise<void>;
}

/** Bumped when the interface above changes shape. Adapters declare what they target. */
export const ADAPTER_CONTRACT_VERSION = 1;
