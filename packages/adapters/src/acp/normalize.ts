/**
 * Agent Client Protocol normalizer — pure, process-free.
 *
 * ACP is the richest transport we speak: the agent runs as a long-lived
 * subprocess, streams structured session updates, and — unlike print-mode
 * CLIs — asks permission before dangerous tool calls instead of deciding
 * alone. That last part is why this tier exists at all.
 *
 * Keeping the mapping pure means fixtures can replay a whole session without
 * spawning anything, which is the only practical way to test a protocol whose
 * CLI requires a vendor login.
 */

import type { ProviderRuntimeEvent } from "@divisio/contracts";

/** Option kinds ACP agents offer on a permission request. */
export type AcpPermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionKind;
}

export interface AcpNormalizeState {
  /** Tool call ids seen this turn, so an update is not reported as a new call. */
  startedToolCalls: Set<string>;
  /** Files already reported edited this turn, so a retry is not counted twice. */
  editedPaths: Set<string>;
  /**
   * What each in-flight tool call has told us so far.
   *
   * A tool call is described across several updates: the kind and the files it
   * touches arrive on one, the completion status on a later one carrying
   * neither. Deciding at completion time therefore needs what the earlier
   * updates said, so it is accumulated here rather than re-read.
   */
  toolCalls: Map<string, { kind?: string; paths: string[] }>;
}

export interface AcpNormalizeResult {
  events: ProviderRuntimeEvent[];
  /** Text contributed by this update, for assistant message accumulation. */
  text: string;
}

export function newAcpState(): AcpNormalizeState {
  return { startedToolCalls: new Set(), editedPaths: new Set(), toolCalls: new Map() };
}

/**
 * Tool kinds that write to disk.
 *
 * Read-only kinds are excluded deliberately: reporting a file as changed
 * because the agent *read* it would put noise in the transcript and make the
 * changed-file list untrustworthy, which is worse than showing nothing.
 */
const WRITING_KINDS = new Set(["edit", "delete", "move"]);

function textFromContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const block = content as Record<string, unknown>;
  if (block["type"] === "text" && typeof block["text"] === "string") return block["text"];
  return "";
}

/** Paths from a tool call's `locations`, ignoring malformed entries. */
function locationPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string" || !path.trim()) continue;
    // A directory listing reports "."; that is not a file that changed.
    if (path === "." || path.endsWith("/")) continue;
    paths.push(path);
  }
  return paths;
}

/** ACP tool-call status vocabulary; anything else is treated as still running. */
function isTerminal(status: unknown): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

function summarizeToolCall(call: Record<string, unknown>): string {
  const title = call["title"];
  if (typeof title === "string" && title.trim()) return title.trim();
  const kind = call["kind"];
  if (typeof kind === "string" && kind.trim()) return kind.trim();
  return "tool call";
}

/**
 * Maps one `session/update` notification onto normalized runtime events.
 *
 * Mutates `state` only to remember which tool calls have already been
 * announced — ACP sends `tool_call` once and then `tool_call_update` repeatedly
 * for the same id, and reporting each update as a fresh call would fill the
 * work list with duplicates.
 */
export function normalizeAcpUpdate(
  update: Record<string, unknown>,
  turnId: string,
  state: AcpNormalizeState,
): AcpNormalizeResult {
  const events: ProviderRuntimeEvent[] = [];
  let text = "";

  const kind = update["sessionUpdate"];

  if (kind === "agent_message_chunk") {
    const piece = textFromContent(update["content"]);
    if (piece) {
      text = piece;
      events.push({ type: "assistant.delta", turnId, text: piece });
    }
    return { events, text };
  }

  // Thinking is surfaced as status, not transcript text: it is not the answer,
  // and folding it into assistant text would corrupt the saved message.
  if (kind === "agent_thought_chunk") {
    return { events, text };
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const id = String(update["toolCallId"] ?? "");
    if (!id) return { events, text };
    const status = update["status"];

    if (!state.startedToolCalls.has(id)) {
      state.startedToolCalls.add(id);
      events.push({
        type: "tool.started",
        turnId,
        toolCallId: id,
        name: summarizeToolCall(update),
        ...(update["rawInput"] !== undefined
          ? { input: JSON.stringify(update["rawInput"]).slice(0, 2000) }
          : {}),
      });
    }

    // Merge what this update adds to what the call already told us.
    const known = state.toolCalls.get(id) ?? { paths: [] };
    if (typeof update["kind"] === "string") known.kind = update["kind"];
    const paths = locationPaths(update["locations"]);
    if (paths.length > 0) known.paths = [...new Set([...known.paths, ...paths])];
    state.toolCalls.set(id, known);

    // Report files a completed write touched. This is the only signal outside a
    // git repository, where checkpoints have nothing to diff.
    if (status === "completed" && known.kind && WRITING_KINDS.has(known.kind)) {
      for (const path of known.paths) {
        if (state.editedPaths.has(path)) continue;
        state.editedPaths.add(path);
        events.push({ type: "file.edited", turnId, path });
      }
    }

    if (isTerminal(status)) {
      state.toolCalls.delete(id);
      events.push({
        type: "tool.finished",
        turnId,
        toolCallId: id,
        ok: status === "completed",
      });
    }
    return { events, text };
  }

  return { events, text };
}

/**
 * Maps a `session/request_permission` payload onto an approval event.
 *
 * Returns null when the request carries no options we can present — offering
 * an approve/deny bar that maps to nothing is worse than staying silent.
 */
export function normalizeAcpPermissionRequest(
  params: Record<string, unknown>,
  turnId: string,
  approvalId: string,
): { event: ProviderRuntimeEvent; options: AcpPermissionOption[] } | null {
  const rawOptions = params["options"];
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;

  const options: AcpPermissionOption[] = [];
  for (const raw of rawOptions) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const optionId = o["optionId"];
    const kind = o["kind"];
    if (typeof optionId !== "string" || !optionId) continue;
    if (
      kind !== "allow_once" &&
      kind !== "allow_always" &&
      kind !== "reject_once" &&
      kind !== "reject_always"
    ) {
      continue;
    }
    options.push({ optionId, name: String(o["name"] ?? optionId), kind });
  }
  if (options.length === 0) return null;

  const toolCall = (params["toolCall"] ?? {}) as Record<string, unknown>;
  return {
    event: {
      type: "approval.requested",
      turnId,
      approvalId,
      category: categoryForToolCall(toolCall),
      summary: summarizeToolCall(toolCall),
    },
    options,
  };
}

/** Divisio's approval categories, derived from the ACP tool-call kind. */
function categoryForToolCall(call: Record<string, unknown>): string {
  const kind = call["kind"];
  switch (kind) {
    case "execute":
      return "shell.exec";
    case "edit":
    case "delete":
    case "move":
      return "fs.write";
    case "read":
      return "fs.read";
    case "fetch":
      return "network";
    default:
      return "other";
  }
}

/**
 * Picks the option id for a binary approve/deny decision.
 *
 * Divisio's wire decision is approve/deny. ACP agents may offer four kinds;
 * prefer the once-scoped option so a single click never silently grants
 * blanket permission for the rest of the session.
 */
export function selectAcpOptionId(
  options: AcpPermissionOption[],
  decision: "approve" | "deny",
): string | null {
  const wanted: AcpPermissionKind[] =
    decision === "approve" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match.optionId;
  }
  return null;
}
