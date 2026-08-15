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
  /** Trailing assistant text — used to space snapshot blocks (`file.` + `Done.`). */
  assistantTail?: string;
}

export interface ClaudeNormalizeResult {
  events: ProviderRuntimeEvent[];
  /** Text contributed by this line (for assistant message accumulation). */
  text: string;
  state: ClaudeNormalizeState;
}

function spaceSnapshotPiece(prev: string | undefined, piece: string): string {
  if (!piece) return "";
  if (!prev) return piece;
  if (/\s$/.test(prev) || /^\s/.test(piece)) return piece;
  if (/[.!?]$/.test(prev) && /^[A-Za-z]/.test(piece)) return ` ${piece}`;
  return piece;
}

function takeTextDelta(delta: Record<string, unknown> | undefined): string {
  if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
    return delta["text"];
  }
  return "";
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
  let assistantTail = state.assistantTail;

  const nextState = (): ClaudeNormalizeState => ({ nativeId, seenPartials, assistantTail });

  const type = msg["type"];

  if (type === "system" && msg["subtype"] === "init") {
    const id = msg["session_id"];
    if (typeof id === "string") nativeId = id;
    return { events, text, state: nextState() };
  }

  // Anthropic Messages streaming (unwrapped) — some CLIs emit this directly.
  if (type === "content_block_delta") {
    const piece = takeTextDelta(msg["delta"] as Record<string, unknown> | undefined);
    if (piece) {
      text = piece;
      events.push({ type: "assistant.delta", turnId, text: piece });
      seenPartials = true;
      assistantTail = piece.slice(-8);
    }
    return { events, text, state: nextState() };
  }

  // Token-level streaming from `claude --include-partial-messages`.
  if (type === "stream_event") {
    const event = msg["event"] as Record<string, unknown> | undefined;
    if (event?.["type"] === "content_block_delta") {
      const piece = takeTextDelta(event["delta"] as Record<string, unknown> | undefined);
      if (piece) {
        text = piece;
        events.push({ type: "assistant.delta", turnId, text: piece });
        seenPartials = true;
        assistantTail = piece.slice(-8);
      }
    }
    return { events, text, state: nextState() };
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
          const piece = spaceSnapshotPiece(assistantTail, b["text"]);
          text += piece;
          events.push({ type: "assistant.delta", turnId, text: piece });
          assistantTail = piece.slice(-8);
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
    return { events, text, state: nextState() };
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
    return { events, text, state: nextState() };
  }

  if (type === "result" && msg["is_error"] === true) {
    events.push({
      type: "error",
      code: "provider_error",
      message: String(msg["result"] ?? "provider reported an error"),
    });
  }

  return { events, text, state: nextState() };
}
