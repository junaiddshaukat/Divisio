import { int, parseTimestampMs, type TranscriptUsage } from "./transcripts.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export interface OpenCodePartMeta {
  id: string;
  sessionId: string;
  timeCreated: unknown;
  model?: string;
}

/**
 * OpenCode `part.data` for `step-finish` carries `tokens.input` / `output`
 * and optional nested `tokens.cache.{read,write}`.
 */
export function parseOpenCodePart(data: unknown, meta: OpenCodePartMeta): TranscriptUsage | null {
  const rec = asRecord(data);
  if (!rec) return null;
  if (rec["type"] !== "step-finish" && rec["tokens"] == null) return null;
  const tokens = asRecord(rec["tokens"]);
  if (!tokens) return null;

  const cache = asRecord(tokens["cache"]) ?? {};
  const inputTokens = int(tokens["input"]) || int(tokens["inputTokens"]) || int(tokens["input_tokens"]);
  const outputTokens = int(tokens["output"]) || int(tokens["outputTokens"]) || int(tokens["output_tokens"]);
  const cacheReadTokens = int(cache["read"]) || int(tokens["cached_tokens"]);
  const cacheWriteTokens = int(cache["write"]);
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return null;

  const timestampMs = parseTimestampMs(meta.timeCreated);
  if (timestampMs === null) return null;

  const model = meta.model?.trim() || "opencode";
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: meta.sessionId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    dedupeKey: meta.id,
  };
}

export function parseOpenCodeModel(messageData: unknown): string {
  const rec = asRecord(messageData);
  if (!rec) return "opencode";
  if (typeof rec["modelID"] === "string" && rec["modelID"].trim()) return rec["modelID"].trim();
  if (typeof rec["model"] === "string" && rec["model"].trim()) return rec["model"].trim();
  const nested = asRecord(rec["model"]);
  if (nested) {
    const id = nested["id"] ?? nested["modelID"] ?? nested["model"];
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return "opencode";
}
