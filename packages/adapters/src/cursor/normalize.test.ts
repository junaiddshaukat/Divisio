import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeCursorStreamLine,
  type CursorNormalizeState,
} from "./normalize.ts";
import { splitNdjson } from "../testkit/replay.ts";

const fixtures = join(import.meta.dir, "../../fixtures/cursor");

function replay(name: string, turnId: string) {
  const raw = readFileSync(join(fixtures, name), "utf8");
  const events = [];
  let state: CursorNormalizeState = { nativeId: null };
  let assistantText = "";
  const unparseable: string[] = [];

  for (const line of splitNdjson(raw)) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unparseable.push(line.slice(0, 120));
      continue;
    }
    const result = normalizeCursorStreamLine(msg, turnId, state);
    state = result.state;
    assistantText += result.text;
    events.push(...result.events);
  }

  return { events, state, assistantText, unparseable };
}

describe("Cursor stream normalizer (golden fixtures)", () => {
  test("text-turn: init + partial deltas; skips final flush duplicate", () => {
    const result = replay("text-turn.ndjson", "trn_text");

    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("ses_fixture_cursor_text");
    expect(result.assistantText).toBe("Hello from Cursor.");
    expect(result.events.filter((e) => e.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", turnId: "trn_text", text: "Hello " },
      { type: "assistant.delta", turnId: "trn_text", text: "from Cursor." },
    ]);
  });

  test("tool-turn: skips model_call_id duplicate; tool.started then finished", () => {
    const result = replay("tool-turn.ndjson", "trn_tool");

    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("ses_fixture_cursor_tool");
    expect(result.assistantText).toBe("I'll read the file.Done.");

    const started = result.events.find((e) => e.type === "tool.started");
    expect(started).toEqual({
      type: "tool.started",
      turnId: "trn_tool",
      toolCallId: "toolu_01",
      name: "Read",
      input: JSON.stringify({ path: "README.md" }),
    });

    const finished = result.events.find((e) => e.type === "tool.finished");
    expect(finished).toMatchObject({
      type: "tool.finished",
      turnId: "trn_tool",
      toolCallId: "toolu_01",
      ok: true,
      output: "# Divisio\n",
    });
  });

  test("error-result: emits provider_error", () => {
    const result = replay("error-result.ndjson", "trn_err");
    expect(result.unparseable).toEqual([]);
    expect(result.events.find((e) => e.type === "error")).toEqual({
      type: "error",
      code: "provider_error",
      message: "not authenticated — run cursor-agent login",
    });
  });

  test("non-partial assistant (no timestamp_ms) is accepted once", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Full segment." }] },
      session_id: "s1",
    });
    const result = normalizeCursorStreamLine(
      JSON.parse(line) as Record<string, unknown>,
      "trn_np",
      { nativeId: null },
    );
    expect(result.text).toBe("Full segment.");
    expect(result.events).toEqual([
      { type: "assistant.delta", turnId: "trn_np", text: "Full segment." },
    ]);
  });
});
