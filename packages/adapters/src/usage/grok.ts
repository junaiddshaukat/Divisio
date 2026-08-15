import { int, parseTimestampMs, type TranscriptUsage } from "./transcripts.ts";

/**
 * Grok session logs only carry a cumulative `totalTokens`. Emit the delta at
 * `turn_completed` / `session_recap` (and a tail if the file ends mid-turn).
 * Do not invent an input/output split.
 */
export interface GrokTranscriptState {
  baseline: number;
  peak: number;
  lastTs: number | null;
  sessionId: string;
  lastPromptId: string;
  turn: number;
}

export function initialGrokTranscriptState(): GrokTranscriptState {
  return {
    baseline: 0,
    peak: 0,
    lastTs: null,
    sessionId: "",
    lastPromptId: "",
    turn: 0,
  };
}

export function grokLineMightCarryUsage(line: string): boolean {
  return (
    line.includes("totalTokens") ||
    line.includes("turn_completed") ||
    line.includes("session_recap")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function emitDelta(state: GrokTranscriptState, model: string): TranscriptUsage | null {
  const tokens = state.peak - state.baseline;
  if (tokens <= 0 || state.lastTs === null) return null;
  state.turn += 1;
  state.baseline = state.peak;
  const prompt = state.lastPromptId || String(state.turn);
  return {
    provider: "grok",
    timestampMs: state.lastTs,
    model,
    sessionId: state.sessionId,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: tokens,
    dedupeKey: `${state.sessionId}:${prompt}:${state.peak}`,
  };
}

export function parseGrokUpdateLine(
  line: string,
  state: GrokTranscriptState,
  model: string,
): TranscriptUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  const params = asRecord(record["params"]) ?? {};
  const meta = asRecord(params["_meta"]) ?? {};
  const update = asRecord(params["update"]) ?? {};

  if (typeof params["sessionId"] === "string") state.sessionId = params["sessionId"];
  if (typeof meta["promptId"] === "string") state.lastPromptId = meta["promptId"];

  const ts = parseTimestampMs(meta["agentTimestampMs"]) ?? parseTimestampMs(record["timestamp"]);
  if (ts !== null) state.lastTs = ts;

  const total = int(meta["totalTokens"]);
  if (total > 0) {
    if (state.peak > 0 && total < state.peak * 0.4) {
      state.baseline = 0;
      state.peak = total;
    } else if (total > state.peak) {
      state.peak = total;
    }
  }

  const kind = update["sessionUpdate"];
  const boundary = kind === "turn_completed" || kind === "session_recap";
  if (!boundary) return null;
  return emitDelta(state, model);
}

/** Remaining peak after the last boundary — in-progress or missing recap. */
export function flushGrokTranscript(state: GrokTranscriptState, model: string): TranscriptUsage | null {
  return emitDelta(state, model);
}
