/**
 * Claude Code stream-json normalizer — pure, process-free.
 *
 * Vendor CLIs change constantly. Golden NDJSON fixtures replay through this
 * module so a breakage fails CI instead of shipping to users first.
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface ClaudeNormalizeState {
  /** Vendor session id from the system/init line. */
  nativeId: string | null;
  /**
   * True once we have accepted a `stream_event` text delta. Later `assistant`
   * snapshots then skip text so we do not double-count partial + final.
   */
  seenPartials?: boolean;
}

export interface ClaudeNormalizeResult {
  events: ProviderRuntimeEvent[];
  /** Text contributed by this line (for assistant message accumulation). */
  text: string;
  state: ClaudeNormalizeState;
}

/**
 * Maps one parsed Claude stream-json object onto normalized runtime events.
 * Does not emit turn.completed — that is the adapter's responsibility when
 * the process exits.
 */
export function normalizeClaudeStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: ClaudeNormalizeState,
): ClaudeNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  let nativeId = state.nativeId;
  let seenPartials = state.seenPartials === true;

  const type = msg["type"];

  if (type === "system" && msg["subtype"] === "init") {
    const id = msg["session_id"];
    if (typeof id === "string") nativeId = id;
    return { events, text, state: { nativeId, seenPartials } };
  }

  // Token-level streaming from `claude --include-partial-messages`.
  if (type === "stream_event") {
    const event = msg["event"] as Record<string, unknown> | undefined;
    if (event?.["type"] === "content_block_delta") {
      const delta = event["delta"] as Record<string, unknown> | undefined;
      if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"]) {
        text = delta["text"];
        events.push({ type: "assistant.delta", turnId, text });
        seenPartials = true;
      }
    }
    return { events, text, state: { nativeId, seenPartials } };
  }

  if (type === "assistant") {
    const message = msg["message"] as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        // When partials already streamed, assistant snapshots are cumulative
        // (or final) and must not append again.
        if (!seenPartials) {
          text += b["text"];
          events.push({ type: "assistant.delta", turnId, text: b["text"] });
        }
      } else if (b["type"] === "tool_use") {
        events.push({
          type: "tool.started",
          turnId,
          toolCallId: String(b["id"] ?? ""),
          name: String(b["name"] ?? "tool"),
          input: JSON.stringify(b["input"] ?? {}).slice(0, 2000),
        });
      }
    }
    return { events, text, state: { nativeId, seenPartials } };
  }

  if (type === "user") {
    const message = msg["message"] as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b["type"] === "tool_result") {
        events.push({
          type: "tool.finished",
          turnId,
          toolCallId: String(b["tool_use_id"] ?? ""),
          ok: b["is_error"] !== true,
          ...(typeof b["content"] === "string" ? { output: b["content"].slice(0, 2000) } : {}),
        });
      }
    }
    return { events, text, state: { nativeId, seenPartials } };
  }

  if (type === "result" && msg["is_error"] === true) {
    events.push({
      type: "error",
      code: "provider_error",
      message: String(msg["result"] ?? "provider reported an error"),
    });
  }

  return { events, text, state: { nativeId, seenPartials } };
}
