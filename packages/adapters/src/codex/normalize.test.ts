import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeCodexApprovalRequest,
  normalizeCodexNotification,
  type CodexNormalizeState,
} from "./normalize.ts";
import { splitNdjson } from "../testkit/replay.ts";

const fixtures = join(import.meta.dir, "../../fixtures/codex");

function replayCodexFixture(name: string, turnId: string) {
  const raw = readFileSync(join(fixtures, name), "utf8");
  const events = [];
  let state: CodexNormalizeState = { turnId, codexTurnId: null, assistantText: "" };
  const unparseable: string[] = [];

  for (const line of splitNdjson(raw)) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unparseable.push(line.slice(0, 120));
      continue;
    }
    const method = typeof msg["method"] === "string" ? msg["method"] : "";
    const result = normalizeCodexNotification(method, msg["params"], state);
    state = result.state;
    events.push(...result.events);
  }

  return { events, state, unparseable };
}

describe("Codex app-server normalizer (golden fixtures)", () => {
  test("text-turn: deltas + message + turn.completed", () => {
    const result = replayCodexFixture("text-turn.ndjson", "trn_text");

    expect(result.unparseable).toEqual([]);
    expect(result.events.filter((e) => e.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", turnId: "trn_text", text: "Hello " },
      { type: "assistant.delta", turnId: "trn_text", text: "from Codex." },
    ]);
    expect(result.events.find((e) => e.type === "assistant.message")).toEqual({
      type: "assistant.message",
      turnId: "trn_text",
      text: "Hello from Codex.",
    });
    expect(result.events.some((e) => e.type === "turn.completed")).toBe(true);
    expect(result.state.turnId).toBeNull();
  });

  test("tool-turn: tool.started then tool.finished", () => {
    const result = replayCodexFixture("tool-turn.ndjson", "trn_tool");

    expect(result.unparseable).toEqual([]);
    const started = result.events.find((e) => e.type === "tool.started");
    expect(started).toEqual({
      type: "tool.started",
      turnId: "trn_tool",
      toolCallId: "item_cmd_1",
      name: "commandExecution",
      input: "ls -la",
    });
    const finished = result.events.find((e) => e.type === "tool.finished");
    expect(finished).toMatchObject({
      type: "tool.finished",
      turnId: "trn_tool",
      toolCallId: "item_cmd_1",
      ok: true,
      output: "total 0\n",
    });
  });

  test("error-turn: emits provider_error and clears turn", () => {
    const result = replayCodexFixture("error-turn.ndjson", "trn_err");

    expect(result.unparseable).toEqual([]);
    const err = result.events.find((e) => e.type === "error");
    expect(err).toEqual({
      type: "error",
      code: "provider_error",
      message: "model overloaded",
    });
    expect(result.events.some((e) => e.type === "turn.completed")).toBe(true);
    expect(result.state.turnId).toBeNull();
  });

  test("command approval request maps to approval.requested", () => {
    const event = normalizeCodexApprovalRequest(
      "item/commandExecution/requestApproval",
      { command: "rm -rf /", reason: "destructive" },
      "trn_appr",
      "42",
    );
    expect(event).toEqual({
      type: "approval.requested",
      turnId: "trn_appr",
      approvalId: "42",
      category: "shell.exec",
      summary: "destructive",
    });
  });

  test("file change approval maps to fs.write", () => {
    const event = normalizeCodexApprovalRequest(
      "item/fileChange/requestApproval",
      { reason: "write README" },
      "trn_appr",
      "7",
    );
    expect(event).toEqual({
      type: "approval.requested",
      turnId: "trn_appr",
      approvalId: "7",
      category: "fs.write",
      summary: "write README",
    });
  });

  test("approval without active turn is ignored", () => {
    expect(
      normalizeCodexApprovalRequest("item/commandExecution/requestApproval", {}, null, "1"),
    ).toBeNull();
  });
});
