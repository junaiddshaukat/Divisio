/**
 * WebSocket wire format. Implements docs/architecture/ws-protocol.md.
 *
 * Every command that acts on in-flight work names its target explicitly.
 * There is no implicit "current" turn or approval — that ambiguity is
 * unresolvable when two clients are attached to the same thread.
 */

import type { ModelCatalog } from "./adapter.ts";
import type { DiffFileEntry, DomainEvent, LaneStatus, PermissionMode, SessionStatus, VendorResumeOutcome } from "./events.ts";

export interface CommandPayloads {
  "session.resume": { since: number; threads: string[] };
  "project.create": { name: string; rootPath: string };
  "project.list": Record<string, never>;
  /**
   * Remove a project from Divisio only. Does not delete the folder on disk,
   * worktrees, or git history — soft-hides the project and its chats.
   */
  "project.remove": { projectId: string };
  "thread.create": { projectId: string; title: string; provider: string; laneId?: string };
  "thread.rename": { threadId: string; title: string };
  "thread.delete": { threadId: string };
  "thread.snapshot": { threadId: string };
  "thread.setPermissionMode": { threadId: string; mode: PermissionMode };
  /**
   * Switch provider/model on an empty thread. Threads with history must use
   * `thread.handoff` to change provider.
   */
  "thread.setProvider": { threadId: string; provider: string; model?: string | null };
  "turn.send": {
    threadId: string;
    text: string;
    model?: string;
    /** Optional images — written into the thread workdir and referenced in the prompt. */
    images?: Array<{ name: string; mimeType: string; dataBase64: string }>;
  };
  "turn.interrupt": { threadId: string; turnId: string };
  /** Drop a message that is waiting to run. */
  "turn.dequeue": { threadId: string; turnId: string };
  "turn.diff": { threadId: string; turnId: string };
  /** Restores the working tree to the state before or after a turn. */
  "turn.restore": { threadId: string; turnId: string; phase: "pre" | "post" };
  /**
   * Stages and commits everything in the thread's working directory.
   * Never invents a message — the client must supply one.
   */
  "thread.commit": { threadId: string; message: string; /** Relative paths; omit to commit all. */ paths?: string[] };
  /**
   * Live git view for the thread workdir.
   * - `working`: porcelain status + `git diff HEAD`
   * - `branch`: lane vs baseSha, or primary checkout vs remote default
   */
  "thread.diff": { threadId: string; scope: "working" | "branch" };
  /** Dirty flag + branch for header git actions. */
  "thread.gitStatus": { threadId: string };
  /** Push the current branch of the thread workdir (`-u` when needed). */
  "thread.push": { threadId: string };
  "approval.respond": { threadId: string; approvalId: string; decision: "approve" | "deny" };
  "provider.detect": Record<string, never>;
  /**
   * Compare installed CLI versions to npm latest. Offline or unknown
   * packages return an empty list — never invented.
   */
  "provider.updates": Record<string, never>;
  /**
   * Live model catalogs from adapters that can list them. `kind` limits the
   * probe to one provider; omit to refresh all. Not a required command —
   * older daemons simply leave the UI on curated aliases.
   */
  "provider.models": { kind?: string };
  "customProvider.list": Record<string, never>;
  "customProvider.upsert": {
    id?: string;
    label: string;
    baseUrl: string;
    modelId: string;
    /** Omit or empty on update to keep the existing key. */
    apiKey?: string;
  };
  "customProvider.delete": { id: string };
  "thread.handoff": {
    threadId: string;
    toProvider: string;
    title?: string;
    /**
     * `log` skips asking the source CLI for a note (usage-limit path).
     * Omit or `auto` to try the source agent, then fall back to the log.
     */
    packet?: "log" | "auto";
  };
  /** Paths are relative to the thread's working directory (lane root or project). */
  "terminal.open": { threadId: string; cols: number; rows: number };
  "terminal.input": { sessionId: string; data: string };
  "terminal.resize": { sessionId: string; cols: number; rows: number };
  "terminal.close": { sessionId: string };
  "file.tree": { threadId: string; path?: string };
  "file.read": { threadId: string; path: string };
  "file.write": { threadId: string; path: string; content: string };
  "pairing.status": Record<string, never>;
  "pairing.createToken": Record<string, never>;
  "pairing.revoke": { clientId: string };
  "pairing.revokeAll": Record<string, never>;
  /** Local toolchain probes (git, host CLIs) for Settings → Source Control. */
  "toolchain.status": Record<string, never>;
  /**
   * Local coding activity for Settings → Profile (heatmap / streaks).
   */
  "stats.activity": Record<string, never>;
  /**
   * Token counts for Settings → Usage.
   * `days` is 7, 30, or 90; default 30. Headline prefers CLI session files
   * on this machine when those homes exist. Not a bill.
   */
  "stats.usage": { days?: 7 | 30 | 90 };
  /**
   * Clone a git remote into `parentPath/<dirname>`, then register it as a project.
   * `name` defaults to the repo folder name.
   */
  "project.clone": { url: string; parentPath: string; name?: string };
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
  /** Preferred CLI model slug, or null for vendor default. */
  model: string | null;
  /**
   * Vendor-native session id last seen on this thread, or null.
   * Resume only happens when the adapter also declares `sessionResume`.
   */
  vendorSessionId: string | null;
  /**
   * Last `startSession` resume outcome, or null if this thread has not
   * started a live session since the field existed.
   */
  vendorResume: VendorResumeOutcome | null;
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

export type AdapterSource = "builtin" | "community" | "custom";

export interface ProviderView {
  kind: string;
  label: string;
  tier: "structured" | "stream" | "pty";
  /** First-party vs opt-in / SDK-loaded community adapter. */
  source: AdapterSource;
  available: boolean;
  version: string | null;
  detail: string | null;
  /**
   * Whether the CLI is signed in. `null` means we cannot tell without side
   * effects — asking some CLIs starts a login flow — so onboarding says so
   * rather than guessing. See packages/adapters/src/shared/setup.ts.
   */
  authenticated: boolean | null;
  /** Command that installs this CLI, so onboarding can hand it over directly. */
  install: string | null;
  /** Command that signs the user in. */
  signIn: string | null;
  capabilities: Record<string, boolean>;
  /** Preferred model for BYOK / custom endpoints. */
  preferredModel?: string | null;
}

/** A CLI on PATH that npm reports a newer version for. */
export interface ProviderUpdate {
  kind: string;
  label: string;
  installed: string;
  latest: string;
  /** Shell command the user runs; Divisio does not execute it. */
  command: string;
}

/** BYOK OpenAI-compatible endpoint (Settings → Providers). API key is masked. */
export interface CustomProviderView {
  id: string;
  kind: string;
  label: string;
  baseUrl: string;
  modelId: string;
  apiKeyPreview: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommandResults {
  "session.resume": { mode: "replay"; through: number } | { mode: "snapshot_required" };
  "project.create": { project: ProjectView };
  "project.list": { projects: ProjectView[]; threads: ThreadView[] };
  "project.remove": Record<string, never>;
  "thread.create": { thread: ThreadView };
  "thread.rename": { thread: ThreadView };
  "thread.delete": Record<string, never>;
  "thread.snapshot": {
    thread: ThreadView;
    messages: MessageView[];
    seq: number;
    /** Live turn id when the session is mid-turn; null when idle. */
    activeTurnId: string | null;
    /**
     * In-flight assistant text for the live turn. Deltas are not in the event
     * log, so a client that left the thread and comes back hydrates from here.
     */
    partial: { turnId: string; text: string } | null;
    /** Checkpoint diffs for chat chips / Changes pane hydration. */
    diffs: Array<{ turnId: string; files: DiffFileEntry[] }>;
  };
  "thread.setPermissionMode": { thread: ThreadView };
  "thread.setProvider": { thread: ThreadView };
  /** `queued` when another turn was running and this one is waiting behind it. */
  "turn.send": { turnId: string; queued?: boolean };
  "turn.interrupt": Record<string, never>;
  "turn.dequeue": { removed: boolean };
  "turn.diff": {
    turnId: string;
    files: DiffFileEntry[];
    patch: string | null;
    status: "ready" | "skipped" | "error" | "missing";
    detail?: string;
  };
  "thread.commit": { ok: boolean; detail?: string };
  "thread.diff": {
    scope: "working" | "branch";
    files: DiffFileEntry[];
    patch: string | null;
    status: "ready" | "skipped" | "error";
    detail?: string;
    branch?: string | null;
  };
  "thread.gitStatus": {
    dirty: boolean;
    branch: string | null;
    laneId: string | null;
    hasRemote: boolean;
    git: boolean;
  };
  "thread.push": { ok: boolean; detail?: string; compareUrl?: string | null };
  "approval.respond": Record<string, never>;
  "turn.restore": {
    status: "restored" | "skipped" | "missing" | "error";
    files: DiffFileEntry[];
    detail?: string;
  };
  "provider.detect": { providers: ProviderView[] };
  "provider.updates": { updates: ProviderUpdate[] };
  "provider.models": { catalogs: Record<string, ModelCatalog> };
  "customProvider.list": { providers: CustomProviderView[] };
  "customProvider.upsert": { provider: CustomProviderView };
  "customProvider.delete": { deleted: boolean };
  "thread.handoff": { thread: ThreadView; summary: string; packet?: "agent" | "log" };
  "terminal.open": { sessionId: string };
  "terminal.input": Record<string, never>;
  "terminal.resize": Record<string, never>;
  "terminal.close": Record<string, never>;
  "file.tree": { entries: FileTreeEntry[]; path: string };
  "file.read": { path: string; content: string; size: number; binary: boolean };
  "file.write": { path: string };
  "pairing.status": PairingStatus;
  "pairing.createToken": { url: string; expiresAt: string; fingerprint: string | null };
  "pairing.revoke": { revoked: boolean };
  "pairing.revokeAll": { revoked: number };
  "toolchain.status": ToolchainStatus;
  "stats.activity": ActivityStats;
  "stats.usage": UsageStats;
  "project.clone": { project: ProjectView };
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

/** One host CLI probed for Settings → Source Control. */
export interface ToolchainToolStatus {
  available: boolean;
  version: string | null;
  /**
   * `true` / `false` when the tool has an auth notion (e.g. `gh`).
   * `null` when auth does not apply (e.g. local `git`).
   */
  authenticated: boolean | null;
  detail: string | null;
}

export interface ToolchainStatus {
  git: ToolchainToolStatus;
  gh: ToolchainToolStatus;
}

/** One calendar day of local coding activity (ISO date YYYY-MM-DD, local timezone). */
export interface ActivityDay {
  date: string;
  turns: number;
  messages: number;
}

export interface ActivityProviderShare {
  kind: string;
  turns: number;
}

export interface ActivityTotals {
  turns: number;
  messages: number;
  threads: number;
  projects: number;
  filesTouched: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
}

/**
 * Settings → Profile. Honest local activity — not GitHub contributions.
 */
export interface ActivityStats {
  days: ActivityDay[];
  providers: ActivityProviderShare[];
  totals: ActivityTotals;
  /** Inclusive day count in `days` (typically ~371 for 53 weeks). */
  rangeDays: number;
}

export type UsageRangeDays = 7 | 30 | 90;

export interface UsageDay {
  date: string;
  tokens: number;
  meteredTurns: number;
}

export interface UsageProviderShare {
  kind: string;
  tokens: number;
  meteredTurns: number;
  unmeteredTurns: number;
}

export interface UsageModelShare {
  model: string;
  provider: string;
  tokens: number;
  events: number;
}

export interface UsageTotals {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  meteredTurns: number;
  unmeteredTurns: number;
  /** Distinct vendor session ids in the window. Additive. */
  sessions: number;
}

export type UsageSource = "machine" | "log";

/**
 * Where the headline numbers came from. `appTokens` is Divisio-orchestrated
 * usage in the same window and is never added on top of machine totals.
 */
export interface UsageCoverage {
  source: UsageSource;
  /** Scanned files or databases per provider kind. */
  files: Record<string, number>;
  sessions: number;
  appTokens: number;
  appMeteredTurns: number;
}

/**
 * Settings → Usage. Headline is CLI session files when those homes exist;
 * otherwise the event log. Never a guessed dollar cost.
 */
export interface UsageStats {
  rangeDays: UsageRangeDays;
  from: string;
  to: string;
  days: UsageDay[];
  providers: UsageProviderShare[];
  models: UsageModelShare[];
  totals: UsageTotals;
  coverage: UsageCoverage;
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

/**
 * Terminal output. Like assistant deltas this is a transport-only frame: it is
 * high-frequency, and replaying a shell session from an append-only log is
 * neither useful nor affordable.
 */
export interface TerminalFrame {
  t: "term";
  sessionId: string;
  data: string;
}

export interface TerminalExitFrame {
  t: "term.exit";
  sessionId: string;
  exitCode: number;
}

export interface ReadyFrame {
  t: "ready";
  protocol: string;
  environmentId: string;
  seq: number;
  /**
   * Compatibility generation. Absent on daemons from before this field
   * existed — treat as incompatible. See `DAEMON_GENERATION` in protocol.ts.
   */
  generation?: number;
  /**
   * Commands this daemon actually routes. Documents the generation; attach
   * decisions use `generation`, not a substring search of this list.
   */
  commands: string[];
}

export interface SubFrame {
  t: "sub";
  threads: string[];
}

export type ClientFrame = ReqFrame | SubFrame;
export type ServerFrame =
  | ResFrame
  | ErrFrame
  | EvtFrame
  | DeltaFrame
  | TerminalFrame
  | TerminalExitFrame
  | ReadyFrame;

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
