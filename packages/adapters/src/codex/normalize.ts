/**
 * Codex app-server notification → ProviderRuntimeEvent.
 *
 * Pure: fixtures replay through this without spawning `codex`.
 * Spec reference: https://developers.openai.com/codex/app-server
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

export interface CodexNormalizeState {
  /** Our orchestration turn id for the in-flight turn (events use this). */
  turnId: string | null;
  /** Codex's turn id from turn/start / turn/started. */
  codexTurnId: string | null;
  /** Accumulated assistant text for the current agent message item. */
  assistantText: string;
}

export interface CodexNormalizeResult {
  events: ProviderRuntimeEvent[];
  state: CodexNormalizeState;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Normalize one Codex app-server notification (`method` + `params`).
 * Server-initiated *requests* (approvals) are handled separately by the adapter.
 */
export function normalizeCodexNotification(
  method: string,
  params: unknown,
  state: CodexNormalizeState,
): CodexNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let next: CodexNormalizeState = { ...state };
  const p = asRecord(params) ?? {};

  switch (method) {
    case "turn/started": {
      const turn = asRecord(p["turn"]);
      const id = turn && typeof turn["id"] === "string" ? turn["id"] : null;
      if (id) next = { ...next, codexTurnId: id, assistantText: "" };
      if (next.turnId) events.push({ type: "status", status: "running" });
      break;
    }

    case "item/agentMessage/delta": {
      const delta = typeof p["delta"] === "string" ? p["delta"] : "";
      if (delta && next.turnId) {
        next = { ...next, assistantText: next.assistantText + delta };
        events.push({ type: "assistant.delta", turnId: next.turnId, text: delta });
      }
      break;
    }

    case "item/started": {
      const item = asRecord(p["item"]);
      if (!item || !next.turnId) break;
      const type = item["type"];
      if (type === "commandExecution") {
        events.push({
          type: "tool.started",
          turnId: next.turnId,
          toolCallId: String(item["id"] ?? ""),
          name: "commandExecution",
          input: typeof item["command"] === "string" ? item["command"] : JSON.stringify(item).slice(0, 2000),
        });
      } else if (type === "fileChange") {
        events.push({
          type: "tool.started",
          turnId: next.turnId,
          toolCallId: String(item["id"] ?? ""),
          name: "fileChange",
          input: JSON.stringify(item["changes"] ?? item).slice(0, 2000),
        });
      } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
        events.push({
          type: "tool.started",
          turnId: next.turnId,
          toolCallId: String(item["id"] ?? ""),
          name: String(item["name"] ?? item["tool"] ?? type),
          input: JSON.stringify(item["arguments"] ?? item["input"] ?? {}).slice(0, 2000),
        });
      }
      break;
    }

    case "item/completed": {
      const item = asRecord(p["item"]);
      if (!item || !next.turnId) break;
      const type = item["type"];
      if (type === "agentMessage") {
        const text =
          typeof item["text"] === "string"
            ? item["text"]
            : next.assistantText.length > 0
              ? next.assistantText
              : "";
        if (text) {
          events.push({ type: "assistant.message", turnId: next.turnId, text });
        }
        next = { ...next, assistantText: "" };
      } else if (
        type === "commandExecution" ||
        type === "fileChange" ||
        type === "mcpToolCall" ||
        type === "dynamicToolCall"
      ) {
        const status = item["status"];
        const ok = status === "completed" || status === "success";
        events.push({
          type: "tool.finished",
          turnId: next.turnId,
          toolCallId: String(item["id"] ?? ""),
          ok,
          ...(typeof item["aggregatedOutput"] === "string"
            ? { output: item["aggregatedOutput"].slice(0, 2000) }
            : typeof item["output"] === "string"
              ? { output: item["output"].slice(0, 2000) }
              : {}),
        });
      }
      break;
    }

    case "turn/completed": {
      const turn = asRecord(p["turn"]);
      const status = turn && typeof turn["status"] === "string" ? turn["status"] : "completed";
      const turnId = next.turnId;
      if (!turnId) break;

      if (status === "failed") {
        const err = asRecord(turn?.["error"]);
        events.push({
          type: "error",
          code: "provider_error",
          message: typeof err?.["message"] === "string" ? err["message"] : "turn failed",
        });
      }

      // Flush any streamed text that never got an item/completed agentMessage.
      if (next.assistantText.length > 0) {
        events.push({ type: "assistant.message", turnId, text: next.assistantText });
      }

      events.push({ type: "turn.completed", turnId });
      events.push({
        type: "status",
        status: status === "interrupted" ? "ready" : status === "failed" ? "error" : "ready",
        ...(status === "failed" ? { detail: "turn failed" } : {}),
      });
      next = { turnId: null, codexTurnId: null, assistantText: "" };
      break;
    }

    case "error": {
      const message =
        typeof p["message"] === "string"
          ? p["message"]
          : typeof asRecord(p["error"])?.["message"] === "string"
            ? String(asRecord(p["error"])!["message"])
            : "codex error";
      events.push({ type: "error", code: "provider_error", message });
      break;
    }

    default:
      break;
  }

  return { events, state: next };
}

/** Map a Codex server-initiated approval request onto our approval event. */
export function normalizeCodexApprovalRequest(
  method: string,
  params: unknown,
  turnId: string | null,
  approvalId: string,
): ProviderRuntimeEvent | null {
  if (!turnId) return null;
  const p = asRecord(params) ?? {};

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof p["command"] === "string" ? p["command"] : "";
    const reason = typeof p["reason"] === "string" ? p["reason"] : "";
    return {
      type: "approval.requested",
      turnId,
      approvalId,
      category: p["networkApprovalContext"] ? "network" : "shell.exec",
      summary: reason || command || "Command execution approval required",
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const reason = typeof p["reason"] === "string" ? p["reason"] : "";
    return {
      type: "approval.requested",
      turnId,
      approvalId,
      category: "fs.write",
      summary: reason || "File change approval required",
    };
  }

  return null;
}
