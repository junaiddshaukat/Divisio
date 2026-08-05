/**
 * Cursor Agent stream-json normalizer — pure, process-free.
 *
 * With `--stream-partial-output`, only assistant events that have
 * `timestamp_ms` and lack `model_call_id` carry new text. Other assistant
 * flushes are duplicates and must be skipped (Cursor docs).
 *
 * Spec: https://cursor.com/docs/cli/reference/output-format
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface CursorNormalizeState {
  /** Vendor session id from system/init — used for --resume. */
  nativeId: string | null;
  /**
   * True once we've accepted a partial assistant delta (`timestamp_ms` set).
   * Lets us skip the final flush that has neither timestamp_ms nor model_call_id.
   */
  seenPartial?: boolean;
}

export interface CursorNormalizeResult {
  events: ProviderRuntimeEvent[];
  /** Text contributed by this line (for assistant message accumulation). */
  text: string;
  state: CursorNormalizeState;
}

const TOOL_NAME: Record<string, string> = {
  readToolCall: "Read",
  writeToolCall: "Write",
  editToolCall: "Edit",
  shellToolCall: "Shell",
  lsToolCall: "LS",
  deleteToolCall: "Delete",
  grepToolCall: "Grep",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractToolCall(toolCall: Record<string, unknown>): {
  name: string;
  args: unknown;
  ok: boolean | null;
  output: string | undefined;
} {
  for (const [key, value] of Object.entries(toolCall)) {
    if (key === "function") {
      const fn = asRecord(value);
      return {
        name: typeof fn?.["name"] === "string" ? fn["name"] : "function",
        args: fn?.["arguments"] ?? {},
        ok: null,
        output: undefined,
      };
    }
    const body = asRecord(value);
    if (!body) continue;
    const result = asRecord(body["result"]);
    let ok: boolean | null = null;
    let output: string | undefined;
    if (result) {
      if ("success" in result) {
        ok = true;
        const success = result["success"];
        if (typeof success === "string") output = success;
        else if (success && typeof success === "object") {
          const s = success as Record<string, unknown>;
          if (typeof s["content"] === "string") output = s["content"];
          else output = JSON.stringify(success).slice(0, 2000);
        }
      } else if ("error" in result || "failure" in result) {
        ok = false;
        output = JSON.stringify(result["error"] ?? result["failure"]).slice(0, 2000);
      }
    }
    return {
      name: TOOL_NAME[key] ?? (key.replace(/ToolCall$/, "") || key),
      args: body["args"] ?? {},
      ok,
      output,
    };
  }
  return { name: "tool", args: {}, ok: null, output: undefined };
}

/**
 * Maps one Cursor stream-json object onto normalized runtime events.
 * Does not emit turn.completed — that is the adapter's job when the process exits.
 */
export function normalizeCursorStreamLine(
  msg: Record<string, unknown>,
  turnId: string,
  state: CursorNormalizeState,
): CursorNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  let nativeId = state.nativeId;
  let seenPartial = state.seenPartial ?? false;

  const type = msg["type"];

  if (type === "system" && msg["subtype"] === "init") {
    const id = msg["session_id"];
    if (typeof id === "string") nativeId = id;
    return { events, text, state: { nativeId, seenPartial } };
  }

  if (type === "assistant") {
    return normalizeAssistant(msg, turnId, nativeId, seenPartial);
  }

  if (type === "tool_call") {
    const callId = String(msg["call_id"] ?? "");
    const toolCall = asRecord(msg["tool_call"]) ?? {};
    const extracted = extractToolCall(toolCall);
    const subtype = msg["subtype"];

    if (subtype === "started") {
      const input =
        typeof extracted.args === "string"
          ? extracted.args.slice(0, 2000)
          : JSON.stringify(extracted.args).slice(0, 2000);
      events.push({
        type: "tool.started",
        turnId,
        toolCallId: callId,
        name: extracted.name,
        input,
      });
    } else if (subtype === "completed") {
      events.push({
        type: "tool.finished",
        turnId,
        toolCallId: callId,
        ok: extracted.ok !== false,
        ...(extracted.output ? { output: extracted.output.slice(0, 2000) } : {}),
      });
    }
    return { events, text, state: { nativeId, seenPartial } };
  }

  if (type === "result" && msg["is_error"] === true) {
    events.push({
      type: "error",
      code: "provider_error",
      message: String(msg["result"] ?? "provider reported an error"),
    });
  }

  if (typeof msg["session_id"] === "string" && !nativeId) {
    nativeId = msg["session_id"];
  }

  return { events, text, state: { nativeId, seenPartial } };
}

function normalizeAssistant(
  msg: Record<string, unknown>,
  turnId: string,
  nativeId: string | null,
  seenPartial: boolean,
): CursorNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";
  let nextPartial = seenPartial;

  const hasTs = typeof msg["timestamp_ms"] === "number";
  const hasModelCall = typeof msg["model_call_id"] === "string";

  // Docs table: skip buffered flush before tool call.
  if (hasModelCall) {
    return { events, text, state: { nativeId, seenPartial: nextPartial } };
  }

  // Docs: absent timestamp_ms after partial streaming = final flush (duplicate).
  if (!hasTs && seenPartial) {
    return { events, text, state: { nativeId, seenPartial: nextPartial } };
  }

  if (hasTs) nextPartial = true;

  const message = asRecord(msg["message"]);
  const content = Array.isArray(message?.["content"]) ? message!["content"] : [];
  for (const block of content) {
    const b = asRecord(block);
    if (b && b["type"] === "text" && typeof b["text"] === "string") {
      text += b["text"];
      events.push({ type: "assistant.delta", turnId, text: b["text"] });
    }
  }

  return { events, text, state: { nativeId, seenPartial: nextPartial } };
}
