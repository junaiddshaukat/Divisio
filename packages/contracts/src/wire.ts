/**
 * WebSocket wire format. Implements docs/architecture/ws-protocol.md.
 *
 * Every command that acts on in-flight work names its target explicitly.
 * There is no implicit "current" turn or approval — that ambiguity is
 * unresolvable when two clients are attached to the same thread.
 */

import type { DiffFileEntry, DomainEvent, PermissionMode, SessionStatus } from "./events.ts";

export interface CommandPayloads {
  "session.resume": { since: number; threads: string[] };
  "project.create": { name: string; rootPath: string };
  "project.list": Record<string, never>;
  "thread.create": { projectId: string; title: string; provider: string };
  "thread.snapshot": { threadId: string };
  "thread.setPermissionMode": { threadId: string; mode: PermissionMode };
  "turn.send": { threadId: string; text: string };
  "turn.interrupt": { threadId: string; turnId: string };
  "turn.diff": { threadId: string; turnId: string };
  "approval.respond": { threadId: string; approvalId: string; decision: "approve" | "deny" };
  "provider.detect": Record<string, never>;
}

export type CommandName = keyof CommandPayloads;

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

export interface ThreadView {
  id: string;
  projectId: string;
  title: string;
  provider: string;
  status: SessionStatus;
  /** Default supervised. Controls whether Divisio mediates provider approvals. */
  permissionMode: PermissionMode;
  updatedAt: string;
}

export interface MessageView {
  turnId: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ProviderView {
  kind: string;
  label: string;
  tier: "structured" | "stream" | "pty";
  available: boolean;
  version: string | null;
  detail: string | null;
  capabilities: Record<string, boolean>;
}

export interface CommandResults {
  "session.resume": { mode: "replay"; through: number } | { mode: "snapshot_required" };
  "project.create": { project: ProjectView };
  "project.list": { projects: ProjectView[]; threads: ThreadView[] };
  "thread.create": { thread: ThreadView };
  "thread.snapshot": { thread: ThreadView; messages: MessageView[]; seq: number };
  "thread.setPermissionMode": { thread: ThreadView };
  "turn.send": { turnId: string };
  "turn.interrupt": Record<string, never>;
  "turn.diff": {
    turnId: string;
    files: DiffFileEntry[];
    patch: string | null;
    status: "ready" | "skipped" | "error" | "missing";
    detail?: string;
  };
  "approval.respond": Record<string, never>;
  "provider.detect": { providers: ProviderView[] };
}

/* ---------------------------------- frames --------------------------------- */

export interface ReqFrame<C extends CommandName = CommandName> {
  t: "req";
  id: string;
  cmd: C;
  payload: CommandPayloads[C];
}

export interface ResFrame<C extends CommandName = CommandName> {
  t: "res";
  id: string;
  payload: CommandResults[C];
}

export interface ErrFrame {
  t: "err";
  id: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface EvtFrame {
  t: "evt";
  event: DomainEvent;
}

/**
 * Streaming token deltas. Deliberately NOT a domain event: deltas are ephemeral
 * render hints, so they may be coalesced on a frame tick and collapsed for a
 * slow consumer. The durable record is the `turn.message` event appended when
 * the turn completes.
 */
export interface DeltaFrame {
  t: "delta";
  threadId: string;
  turnId: string;
  text: string;
}

export interface ReadyFrame {
  t: "ready";
  protocol: string;
  environmentId: string;
  seq: number;
}

export interface SubFrame {
  t: "sub";
  threads: string[];
}

export type ClientFrame = ReqFrame | SubFrame;
export type ServerFrame = ResFrame | ErrFrame | EvtFrame | DeltaFrame | ReadyFrame;

/* ---------------------------------- errors --------------------------------- */

export const ERROR_CODES = {
  bad_frame: "bad_frame",
  unknown_command: "unknown_command",
  invalid_payload: "invalid_payload",
  not_found: "not_found",
  provider_unavailable: "provider_unavailable",
  session_busy: "session_busy",
  internal: "internal",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CommandError";
  }
}
