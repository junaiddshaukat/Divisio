/**
 * Vendor transcript parsers for Settings → Usage.
 *
 * Claude Code and Codex write token counters into on-disk JSONL. These helpers
 * map those lines onto disjoint token parts. They never read message text into
 * the returned record. Callers must dedupe Claude by `dedupeKey` — each
 * assistant content block repeats the parent message's full usage object.
 */

export type TranscriptProvider = "claude" | "codex";

export interface TranscriptUsage {
  provider: TranscriptProvider;
  timestampMs: number;
  model: string;
  sessionId: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /**
   * Claude: `${messageId}:${requestId}`. Identical keys are the same request.
   * Codex: null — uniqueness is handled per-file (duplicate token_count skip).
   */
  dedupeKey: string | null;
}

export function processedTokens(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Cheap gate before JSON.parse — most Claude jsonl lines are tool output. */
export function claudeLineMightCarryUsage(line: string): boolean {
  return line.includes('"usage"');
}

export function parseClaudeTranscriptLine(line: string): TranscriptUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"].trim() : "";
  if (!model) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : "";
  const dedupeKey =
    messageId === null && requestId === null
      ? `${sessionId}:${timestampMs}:${model}`
      : `${messageId ?? ""}:${requestId ?? ""}`;

  const inputTokens = int(usageRecord["input_tokens"]);
  const cacheReadTokens = int(usageRecord["cache_read_input_tokens"]);
  const cacheWriteTokens = int(usageRecord["cache_creation_input_tokens"]);
  const outputTokens = int(usageRecord["output_tokens"]);
  if (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === 0) return null;

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    dedupeKey,
  };
}

/**
 * Rolling state for one Codex rollout file.
 *
 * `token_count` has no model — carry it from the latest `turn_context`.
 * Forked/subagent files copy the parent history at the fork instant; those
 * copies were already counted in the parent file and must be dropped.
 */
export interface CodexTranscriptState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexTranscriptState(): CodexTranscriptState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/** Parent copies land in a burst; a real child turn is seconds later. */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

export function codexLineMightCarryUsage(line: string): boolean {
  return (
    line.includes("token_count") ||
    line.includes("session_meta") ||
    line.includes("turn_context")
  );
}

export function parseCodexTranscriptLine(
  line: string,
  state: CodexTranscriptState,
): TranscriptUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;

  if (record["type"] === "session_meta") {
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadRecord["type"] !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (!state.model) return null;

  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputInclusive = int(lastRecord["input_tokens"]);
  const cacheReadTokens = int(lastRecord["cached_input_tokens"]);
  const cacheWriteTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);
  // Codex `input_tokens` already includes the cached portion.
  const inputTokens = Math.max(0, inputInclusive - cacheReadTokens - cacheWriteTokens);
  if (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    dedupeKey: null,
  };
}
