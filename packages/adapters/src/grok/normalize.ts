/**
 * Grok Build stream normalizer — pure, process-free.
 *
 * Current `grok --output-format streaming-json` emits `{type:"text",data}`
 * deltas. Older builds used Anthropic Messages-shaped NDJSON
 * (`streaming-messages-json`); those lines fall through to the Claude
 * normalizer so a CLI upgrade does not blank the transcript.
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";
import {
  normalizeClaudeStreamLine,
  type ClaudeNormalizeResult,
  type ClaudeNormalizeState,
} from "../claude/normalize.ts";

export type GrokNormalizeState = ClaudeNormalizeState;
export type GrokNormalizeResult = ClaudeNormalizeResult;

function sessionIdFrom(msg: Record<string, unknown>): string | null {
  const id = msg["sessionId"] ?? msg["session_id"];
  return typeof id === "string" && id.trim() ? id : null;
}

export function normalizeGrokStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: GrokNormalizeState,
): GrokNormalizeResult {
  const type = msg["type"];

  if (type === "text") {
    const data = typeof msg["data"] === "string" ? msg["data"] : "";
    if (!data) return { events: [], text: "", state };
    return {
      events: [{ type: "assistant.delta", turnId, text: data }],
      text: data,
      state: { ...state, seenPartials: true },
    };
  }

  if (type === "thought") {
    // Reasoning tokens are not a runtime event yet — skip so they do not
    // splice into the visible answer.
    return { events: [], text: "", state };
  }

  if (type === "end") {
    const nativeId = sessionIdFrom(msg) ?? state.nativeId;
    return { events: [], text: "", state: { ...state, nativeId } };
  }

  if (type === "error") {
    const message = String(msg["message"] ?? msg["error"] ?? "grok reported an error");
    const events: ProviderRuntimeEvent[] = [
      { type: "error", code: "provider_error", message },
    ];
    return { events, text: "", state };
  }

  return normalizeClaudeStreamLine(msg, turnId, state);
}
