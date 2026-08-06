/**
 * Antigravity CLI (`agy`) stream-json → Divisio events.
 * Envelope: { event: "init"|"step_update"|"result", … }
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface AntigravityNormalizeState {
  nativeId: string | null;
  activeTools: Map<number, string>;
  toolSeq: number;
  hadAssistantText: boolean;
}

export interface AntigravityNormalizeResult {
  events: ProviderRuntimeEvent[];
  text: string;
  state: AntigravityNormalizeState;
}

export function normalizeAntigravityStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: AntigravityNormalizeState,
): AntigravityNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  const event = msg.event;

  if (event === "init") {
    const init = msg.init && typeof msg.init === "object" ? (msg.init as Record<string, unknown>) : {};
    const conversationId =
      (typeof msg.conversation_id === "string" && msg.conversation_id) ||
      (typeof init.conversation_id === "string" && init.conversation_id) ||
      null;
    if (conversationId) state = { ...state, nativeId: conversationId };
    return { events, text, state };
  }

  if (event === "step_update") {
    const step =
      msg.step_update && typeof msg.step_update === "object"
        ? (msg.step_update as Record<string, unknown>)
        : {};
    if (typeof step.conversation_id === "string") {
      state = { ...state, nativeId: step.conversation_id };
    }

    const stepType = step.step_type;
    const stepState = step.state;
    const stepIndex = typeof step.step_index === "number" ? step.step_index : -1;

    if (stepType === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
      text = step.text_delta;
      state = { ...state, hadAssistantText: true };
      events.push({ type: "assistant.delta", turnId, text: step.text_delta });
    }

    if (stepType === "tool") {
      const toolInfo =
        step.tool_info && typeof step.tool_info === "object"
          ? (step.tool_info as Record<string, unknown>)
          : null;
      const name =
        (typeof step.tool_name === "string" && step.tool_name) ||
        (toolInfo && typeof toolInfo.name === "string" && toolInfo.name) ||
        "tool";

      if (stepState === "ACTIVE") {
        const toolCallId = `agy_${stepIndex >= 0 ? stepIndex : state.toolSeq++}`;
        state.activeTools.set(stepIndex, toolCallId);
        const input =
          toolInfo?.parameters !== undefined
            ? JSON.stringify(toolInfo.parameters).slice(0, 4000)
            : undefined;
        events.push({ type: "tool.started", turnId, toolCallId, name, input });
      } else if (stepState === "DONE") {
        const hadActive = state.activeTools.has(stepIndex);
        const toolCallId =
          state.activeTools.get(stepIndex) ?? `agy_${stepIndex >= 0 ? stepIndex : state.toolSeq++}`;
        state.activeTools.delete(stepIndex);
        const ok = !(toolInfo && toolInfo.error);
        const output =
          toolInfo && typeof toolInfo.output === "string"
            ? toolInfo.output.slice(0, 4000)
            : toolInfo?.error
              ? JSON.stringify(toolInfo.error).slice(0, 4000)
              : undefined;
        if (!hadActive) {
          const input =
            toolInfo?.parameters !== undefined
              ? JSON.stringify(toolInfo.parameters).slice(0, 4000)
              : undefined;
          events.push({ type: "tool.started", turnId, toolCallId, name, input });
        }
        events.push({ type: "tool.finished", turnId, toolCallId, ok, output });
      }
    }

    return { events, text, state };
  }

  if (event === "result") {
    const result =
      msg.result && typeof msg.result === "object" ? (msg.result as Record<string, unknown>) : msg;
    if (typeof result.conversation_id === "string") {
      state = { ...state, nativeId: result.conversation_id };
    }
    if (result.status === "ERROR" || result.status === "error") {
      events.push({
        type: "error",
        code: "provider_error",
        message: typeof result.error === "string" ? result.error : "agy run failed",
      });
    } else if (
      typeof result.response === "string" &&
      result.response.length > 0 &&
      !state.hadAssistantText
    ) {
      text = result.response;
      state = { ...state, hadAssistantText: true };
      events.push({ type: "assistant.delta", turnId, text: result.response });
    }
  }

  return { events, text, state };
}
