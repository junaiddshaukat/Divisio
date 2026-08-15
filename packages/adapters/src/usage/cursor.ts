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

  const inputTokens = int(tokenCount["inputTokens"]) || int(tokenCount["input_tokens"]);
  const outputTokens = int(tokenCount["outputTokens"]) || int(tokenCount["output_tokens"]);
  if (inputTokens + outputTokens === 0) return null;

  const timestampMs = parseTimestampMs(rec["createdAt"]) ?? parseTimestampMs(rec["timestamp"]);
  if (timestampMs === null) return null;

  const modelInfo = asRecord(rec["modelInfo"]) ?? {};
  const model =
    stringField(rec["modelName"], rec["model"], modelInfo["modelName"], modelInfo["model"]) || "cursor";

  const keyParts = key.split(":");
  const sessionId = keyParts.length >= 2 ? keyParts[1]! : "";
  const bubbleId = stringField(rec["bubbleId"], keyParts.at(-1), key);

  return {
    provider: "cursor",
    timestampMs,
    model,
    sessionId,
    inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    dedupeKey: bubbleId,
  };
}
