/**
 * WebSocket wire format. Implements docs/architecture/ws-protocol.md.
 *
 * Every command that acts on in-flight work names its target explicitly.
 * There is no implicit "current" turn or approval — that ambiguity is
 * unresolvable when two clients are attached to the same thread.
 */

import type { DiffFileEntry, DomainEvent, LaneStatus, PermissionMode, SessionStatus } from "./events.ts";

export interface CommandPayloads {
  "session.resume": { since: number; threads: string[] };
  "project.create": { name: string; rootPath: string };
  "project.list": Record<string, never>;
  "thread.create": { projectId: string; title: string; provider: string; laneId?: string };
  "thread.snapshot": { threadId: string };
  "thread.setPermissionMode": { threadId: string; mode: PermissionMode };
  "turn.send": { threadId: string; text: string };
  "turn.interrupt": { threadId: string; turnId: string };
  "turn.diff": { threadId: string; turnId: string };
  "approval.respond": { threadId: string; approvalId: string; decision: "approve" | "deny" };
  "provider.detect": Record<string, never>;
  "thread.handoff": { threadId: string; toProvider: string; title?: string };
  /** Paths are relative to the thread's working directory (lane root or project). */
  "file.tree": { threadId: string; path?: string };
  "file.read": { threadId: string; path: string };
  "file.write": { threadId: string; path: string; content: string };
  "pairing.status": Record<string, never>;
  "pairing.createToken": Record<string, never>;
  "pairing.revoke": { clientId: string };
  "pairing.revokeAll": Record<string, never>;
  "lane.create": { projectId: string; title: string; base?: string };
  "lane.list": { projectId?: string };
  "lane.archive": { laneId: string; deleteBranch: boolean; force: boolean };
  "lane.diff": { laneId: string };
  /**
   * `commitMessage` is required only when the lane has uncommitted work. A PR
   * cannot be opened from an unrecorded working tree, and silently committing
   * on the user's behalf would be worse than asking.
   */
  "lane.openPr": { laneId: string; title: string; body: string; commitMessage?: string };
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
  /** Null when the thread runs in the primary checkout. */
  laneId: string | null;
  /** Default supervised. Controls whether Divisio mediates provider approvals. */
  permissionMode: PermissionMode;
  updatedAt: string;
}

export interface LaneView {
  id: string;
  projectId: string;
  title: string;
  branch: string;
  baseSha: string;
  root: string;
  port: number;
  status: LaneStatus;
  detail: string | null;
  createdAt: string;
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
  "thread.handoff": { thread: ThreadView; summary: string };
  "file.tree": { entries: FileTreeEntry[]; path: string };
  "file.read": { path: string; content: string; size: number; binary: boolean };
  "file.write": { path: string };
  "pairing.status": PairingStatus;
  "pairing.createToken": { url: string; expiresAt: string; fingerprint: string | null };
  "pairing.revoke": { revoked: boolean };
  "pairing.revokeAll": { revoked: number };
  "lane.create": { lane: LaneView };
  "lane.list": { lanes: LaneView[] };
  "lane.archive": { lane: LaneView };
  "lane.diff": { files: DiffFileEntry[]; patch: string | null; status: "ready" | "skipped" | "error" };
  "lane.openPr": PrResult;
}

/**
 * Opening a PR degrades in stages rather than failing outright: create it with
 * `gh` when that is available and authenticated, otherwise push and hand back a
 * compare URL, otherwise report exactly which step failed.
 */
export interface FileTreeEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
}

export interface PairedClient {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PairingStatus {
  /** False when the daemon is bound to loopback; pairing is meaningless then. */
  remote: boolean;
  tls: boolean;
  address: string | null;
  fingerprint: string | null;
  clients: PairedClient[];
}

export interface PrResult {
  status: "created" | "pushed" | "needs_commit" | "error";
  /** Set when `gh` created the PR. */
  url: string | null;
  /** Set when we pushed but could not create the PR — open this in a browser. */
  compareUrl: string | null;
  branch: string;
  detail: string | null;
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
