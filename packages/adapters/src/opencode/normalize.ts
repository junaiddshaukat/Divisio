/**
 * OpenCode stream-json / `--format json` normalizer.
 *
 * OpenCode emits SDK event envelopes. We extract assistant text and tools
 * without depending on `@opencode-ai/sdk` in the daemon.
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface OpenCodeNormalizeState {
  nativeId: string | null;
  /** Last emitted text length per part id, so updates become deltas. */
  textLens: Map<string, number>;
}

export interface OpenCodeNormalizeResult {
  events: ProviderRuntimeEvent[];
  text: string;
  state: OpenCodeNormalizeState;
}

function partFrom(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg["part"] && typeof msg["part"] === "object") return msg["part"] as Record<string, unknown>;
  const props = msg["properties"];
  if (props && typeof props === "object") {
    const p = (props as Record<string, unknown>)["part"];
    if (p && typeof p === "object") return p as Record<string, unknown>;
  }
  return null;
}

export function normalizeOpenCodeStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: OpenCodeNormalizeState,
): OpenCodeNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  let nativeId = state.nativeId;
  const textLens = new Map(state.textLens);

  const type = String(msg["type"] ?? "");

  // Session id from various envelope shapes.
  for (const key of ["sessionID", "session_id", "sessionId"]) {
    const v = msg[key];
    if (typeof v === "string") nativeId = v;
  }
  const props = msg["properties"];
  if (props && typeof props === "object") {
    const info = (props as Record<string, unknown>)["info"];
    if (info && typeof info === "object") {
      const id = (info as Record<string, unknown>)["id"];
      if (typeof id === "string") nativeId = id;
    }
    const sid = (props as Record<string, unknown>)["sessionID"];
    if (typeof sid === "string") nativeId = sid;
  }

  if (type === "session.error" || (type === "error" && msg["message"])) {
    events.push({
      type: "error",
      code: "provider_error",
      message: String(
        (props as Record<string, unknown> | undefined)?.["message"] ??
          msg["message"] ??
          "opencode error",
      ),
    });
    return { events, text, state: { nativeId, textLens } };
  }

  const part = partFrom(msg);
  if (part) {
    const partType = String(part["type"] ?? "");
    const partId = String(part["id"] ?? part["messageID"] ?? "part");

    if (partType === "text" && typeof part["text"] === "string") {
      const full = part["text"] as string;
      const prev = textLens.get(partId) ?? 0;
      if (full.length >= prev) {
        const delta = full.slice(prev);
        textLens.set(partId, full.length);
        if (delta) {
          text = delta;
          events.push({ type: "assistant.delta", turnId, text: delta });
        }
      }
    }

    if (partType === "tool") {
      const tool = String(part["tool"] ?? "tool");
      const status = (part["state"] as { status?: string } | undefined)?.status;
      const callId = String(part["callID"] ?? part["id"] ?? tool);
      if (status === "pending" || status === "running" || !status) {
        events.push({
          type: "tool.started",
          turnId,
          toolCallId: callId,
          name: tool,
        });
      } else if (status === "completed" || status === "error") {
        events.push({
          type: "tool.finished",
          turnId,
          toolCallId: callId,
          ok: status === "completed",
        });
      }
    }
  }

  // Compact `{ type: "text", text: "..." }` fallbacks some builds emit.
  if (type === "text" && typeof msg["text"] === "string") {
    text = msg["text"] as string;
    events.push({ type: "assistant.delta", turnId, text });
  }

  return { events, text, state: { nativeId, textLens } };
}
