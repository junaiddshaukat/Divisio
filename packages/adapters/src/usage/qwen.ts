import { int, parseTimestampMs, type TranscriptUsage } from "./transcripts.ts";

export function qwenLineMightCarryUsage(line: string): boolean {
  return (
    line.includes("inputTokens") ||
    line.includes("input_tokens") ||
    line.includes("totalTokens") ||
    line.includes("total_tokens")
  );
}

/**
 * Qwen writes first-class usage jsonl. `thoughtsTokens` is already inside
 * `outputTokens` or `totalTokens` — do not add it on top.
 */
export function parseQwenUsageLine(line: string): TranscriptUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;

  const timestampMs = parseTimestampMs(rec["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof rec["model"] === "string" && rec["model"].trim() ? rec["model"].trim() : "qwen";
  const sessionId = typeof rec["sessionId"] === "string" ? rec["sessionId"] : "";
  const id = typeof rec["id"] === "string" ? rec["id"] : null;

  const inputTokens = int(rec["inputTokens"]) || int(rec["input_tokens"]);
  const outputTokens = int(rec["outputTokens"]) || int(rec["output_tokens"]);
  const cacheReadTokens = int(rec["cachedTokens"]) || int(rec["cached_tokens"]) || int(rec["cache_read_tokens"]);
  const parts = inputTokens + outputTokens + cacheReadTokens;
  const totalTokens = int(rec["totalTokens"]) || int(rec["total_tokens"]);
  if (parts === 0 && totalTokens === 0) return null;

  return {
    provider: "qwen",
    timestampMs,
    model,
    sessionId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens,
    ...(parts === 0 ? { totalTokens } : {}),
    dedupeKey: id,
  };
}
