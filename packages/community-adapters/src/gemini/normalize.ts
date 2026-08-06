/**
 * Gemini CLI stream-json → Divisio runtime events.
 * Events: init | message | tool_use | tool_result | error | result
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface GeminiNormalizeState {
  nativeId: string | null;
  seenTools: Set<string>;
}

export interface GeminiNormalizeResult {
  events: ProviderRuntimeEvent[];
  text: string;
  state: GeminiNormalizeState;
}

export function normalizeGeminiStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: GeminiNormalizeState,
): GeminiNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  const type = msg.type;

  if (type === "init") {
    const sessionId = typeof msg.session_id === "string" ? msg.session_id : null;
    if (sessionId) state = { ...state, nativeId: sessionId };
    return { events, text, state };
  }

  if (type === "message") {
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 0) {
      // delta:true means incremental chunk; omit means full/final — emit once either way
      text = msg.content;
      events.push({ type: "assistant.delta", turnId, text: msg.content });
    }
    return { events, text, state };
  }

  if (type === "tool_use") {
    const toolCallId = typeof msg.tool_id === "string" ? msg.tool_id : `tool_${state.seenTools.size}`;
    const name = typeof msg.tool_name === "string" ? msg.tool_name : "tool";
    state.seenTools.add(toolCallId);
    const input =
      msg.parameters !== undefined ? JSON.stringify(msg.parameters).slice(0, 4000) : undefined;
    events.push({ type: "tool.started", turnId, toolCallId, name, input });
    return { events, text, state };
  }

  if (type === "tool_result") {
    const toolCallId = typeof msg.tool_id === "string" ? msg.tool_id : "tool_unknown";
    const ok = msg.status !== "error";
    const output =
      typeof msg.output === "string"
        ? msg.output.slice(0, 4000)
        : msg.error && typeof msg.error === "object"
          ? JSON.stringify(msg.error).slice(0, 4000)
          : undefined;
    events.push({ type: "tool.finished", turnId, toolCallId, ok, output });
    return { events, text, state };
  }

  if (type === "error") {
    if (msg.severity === "error" || msg.severity === undefined) {
      events.push({
        type: "error",
        code: "provider_error",
        message: typeof msg.message === "string" ? msg.message : "gemini error",
      });
    }
    return { events, text, state };
  }

  if (type === "result" && msg.status === "error") {
    const err = msg.error;
    const message =
      err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "gemini run failed";
    events.push({ type: "error", code: "provider_error", message });
  }

  return { events, text, state };
}
