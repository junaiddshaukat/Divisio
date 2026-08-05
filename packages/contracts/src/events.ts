/**
 * Domain events — the durable truth. Everything the UI renders derives from these.
 *
 * ADR 0004 rules that apply to every edit in this file:
 *   - Events are immutable once written. Never change what a stored event means.
 *   - Adding an OPTIONAL field readers can ignore does not bump `v`.
 *   - Anything else bumps `v` and ships an upcaster in the SAME commit.
 *   - Retired event types keep their upcasters forever, or old logs stop replaying.
 *
 * See packages/contracts/src/upcast.ts.
 */

export const EVENT_VERSIONS = {
  "project.created": 1,
  "thread.created": 1,
  "turn.started": 1,
  "turn.message": 1,
  "turn.completed": 1,
  "turn.interrupted": 1,
  "turn.failed": 1,
  "session.status": 1,
  "approval.requested": 1,
  "approval.resolved": 1,
  "tool.started": 1,
  "tool.finished": 1,
} as const;

export type EventType = keyof typeof EVENT_VERSIONS;

export type SessionStatus =
  | "connecting"
  | "ready"
  | "running"
  | "awaiting_approval"
  /** Interrupt sent, provider not yet confirmed quiet. Never report `ready` here. */
  | "stopping"
  | "error"
  | "closed";

export type TurnRole = "user" | "assistant";

export interface EventPayloads {
  "project.created": { projectId: string; name: string; rootPath: string };
  "thread.created": { threadId: string; projectId: string; title: string; provider: string };
  "turn.started": { threadId: string; turnId: string; provider: string };
  /** A complete message. Streaming deltas are transport-only and never stored. */
  "turn.message": { threadId: string; turnId: string; role: TurnRole; text: string };
  "turn.completed": { threadId: string; turnId: string };
  "turn.interrupted": { threadId: string; turnId: string };
  "turn.failed": { threadId: string; turnId: string; code: string; message: string };
  "session.status": { threadId: string; status: SessionStatus; detail?: string };
  "approval.requested": {
    threadId: string;
    turnId: string;
    approvalId: string;
    category: "fs.write" | "fs.read" | "shell.exec" | "network" | "other";
    summary: string;
  };
  "approval.resolved": {
    threadId: string;
    approvalId: string;
    decision: "approve" | "deny";
  };
  "tool.started": { threadId: string; turnId: string; toolCallId: string; name: string; input?: string };
  "tool.finished": { threadId: string; turnId: string; toolCallId: string; ok: boolean; output?: string };
}

/** An event as stored and as broadcast. `seq` is assigned at append time. */
export interface DomainEvent<T extends EventType = EventType> {
  seq: number;
  type: T;
  v: number;
  threadId: string | null;
  at: string;
  payload: EventPayloads[T];
}

/** An event before the log assigns it a sequence number. */
export type NewEvent<T extends EventType = EventType> = {
  [K in T]: { type: K; threadId: string | null; payload: EventPayloads[K] };
}[T];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_VERSIONS, value);
}
