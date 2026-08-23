import { int, parseTimestampMs, type TranscriptUsage } from "./transcripts.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export interface CursorBubbleFields {
  inputTokens?: unknown;
  outputTokens?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  model?: unknown;
  bubbleId?: unknown;
}

/**
 * Token counters only. Callers that already extracted fields from SQLite
 * must not pass the composer blob — those values are multi-megabyte chats.
 */
export function cursorUsageFromFields(key: string, fields: CursorBubbleFields): TranscriptUsage | null {
  const inputTokens = int(fields.inputTokens);
  const outputTokens = int(fields.outputTokens);
  if (inputTokens + outputTokens === 0) return null;

  const timestampMs = parseTimestampMs(fields.createdAt) ?? parseTimestampMs(fields.timestamp);
  if (timestampMs === null) return null;

  const keyParts = key.split(":");
  const sessionId = keyParts.length >= 2 ? keyParts[1]! : "";
  const bubbleId = stringField(fields.bubbleId, keyParts.at(-1), key);

  return {
    provider: "cursor",
    timestampMs,
    model: stringField(fields.model) || "cursor",
    sessionId,
    inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    dedupeKey: bubbleId,
  };
}

/**
 * Cursor composer bubbles store native `tokenCount.inputTokens` /
 * `outputTokens`. `key` is `bubbleId:<composerId>:<bubbleId>`.
 */
export function parseCursorBubble(value: string, key: string): TranscriptUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  const tokenCount = asRecord(rec["tokenCount"]);
  if (!tokenCount) return null;
  const modelInfo = asRecord(rec["modelInfo"]) ?? {};
  return cursorUsageFromFields(key, {
    inputTokens: tokenCount["inputTokens"] ?? tokenCount["input_tokens"],
    outputTokens: tokenCount["outputTokens"] ?? tokenCount["output_tokens"],
    createdAt: rec["createdAt"],
    timestamp: rec["timestamp"],
    model: stringField(rec["modelName"], rec["model"], modelInfo["modelName"], modelInfo["model"]),
    bubbleId: rec["bubbleId"],
  });
}
