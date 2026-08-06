/**
 * GitHub Copilot CLI JSONL (`--output-format json`) → Divisio events.
 * Observed shapes: assistant.message_delta / assistant.message / session.idle
 * and nested `{ type, data }` envelopes from the Copilot SDK wire.
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface CopilotNormalizeState {
  nativeId: string | null;
  seenTools: Set<string>;
  hadDelta: boolean;
}

export interface CopilotNormalizeResult {
  events: ProviderRuntimeEvent[];
  text: string;
  state: CopilotNormalizeState;
}

function dataOf(msg: Record<string, unknown>): Record<string, unknown> {
  return msg.data && typeof msg.data === "object" ? (msg.data as Record<string, unknown>) : msg;
}

export function normalizeCopilotStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: CopilotNormalizeState,
): CopilotNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  const type = typeof msg.type === "string" ? msg.type : "";
  const data = dataOf(msg);

  if (type === "session.created" || type === "session.start") {
    const id =
      (typeof data.sessionId === "string" && data.sessionId) ||
      (typeof data.id === "string" && data.id) ||
      null;
    if (id) state = { ...state, nativeId: id };
    return { events, text, state };
  }

  if (type === "assistant.message_delta" || type === "assistant.delta") {
    const chunk =
      (typeof data.deltaContent === "string" && data.deltaContent) ||
      (typeof data.content === "string" && data.content) ||
      (typeof data.delta === "string" && data.delta) ||
      "";
    if (chunk) {
      text = chunk;
      state = { ...state, hadDelta: true };
      events.push({ type: "assistant.delta", turnId, text: chunk });
    }
    return { events, text, state };
  }

  if (type === "assistant.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content && !state.hadDelta) {
      text = content;
      events.push({ type: "assistant.delta", turnId, text: content });
    }
    return { events, text, state };
  }

  if (type === "tool.execution_start" || type === "tool_call.start" || type === "tool.started") {
    const toolCallId =
      (typeof data.toolCallId === "string" && data.toolCallId) ||
      (typeof data.id === "string" && data.id) ||
      `tool_${state.seenTools.size}`;
    const name =
      (typeof data.toolName === "string" && data.toolName) ||
      (typeof data.name === "string" && data.name) ||
      "tool";
    state.seenTools.add(toolCallId);
    const input =
      data.arguments !== undefined
        ? JSON.stringify(data.arguments).slice(0, 4000)
        : data.input !== undefined
          ? String(data.input).slice(0, 4000)
          : undefined;
    events.push({ type: "tool.started", turnId, toolCallId, name, input });
    return { events, text, state };
  }

  if (
    type === "tool.execution_complete" ||
    type === "tool_call.complete" ||
    type === "tool.finished"
  ) {
    const toolCallId =
      (typeof data.toolCallId === "string" && data.toolCallId) ||
      (typeof data.id === "string" && data.id) ||
      "tool_unknown";
    const ok = data.error === undefined && data.ok !== false;
    const output =
      typeof data.output === "string"
        ? data.output.slice(0, 4000)
        : data.result !== undefined
          ? JSON.stringify(data.result).slice(0, 4000)
          : undefined;
    events.push({ type: "tool.finished", turnId, toolCallId, ok, output });
    return { events, text, state };
  }

  if (type === "error" || type === "session.error") {
    events.push({
      type: "error",
      code: "provider_error",
      message:
        (typeof data.message === "string" && data.message) ||
        (typeof msg.message === "string" && msg.message) ||
        "copilot error",
    });
  }

  return { events, text, state };
}
