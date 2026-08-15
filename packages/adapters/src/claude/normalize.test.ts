import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { replayFixtureFile, replayNdjson } from "../testkit/replay.ts";

const fixtures = join(import.meta.dir, "../../fixtures/claude");

describe("Claude stream normalizer (golden fixtures)", () => {
  test("text-turn: init + deltas + session id", () => {
    const result = replayFixtureFile(join(fixtures, "text-turn.ndjson"), "trn_text");

    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("ses_fixture_text_001");
    expect(result.assistantText).toBe("Hello from Claude.");
    expect(result.events.filter((e) => e.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", turnId: "trn_text", text: "Hello " },
      { type: "assistant.delta", turnId: "trn_text", text: "from Claude." },
    ]);
    expect(result.events.some((e) => e.type === "error")).toBe(false);
  });

  test("tool-turn: tool.started then tool.finished", () => {
    const result = replayFixtureFile(join(fixtures, "tool-turn.ndjson"), "trn_tool");

    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("ses_fixture_tool_001");

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

    expect(result.assistantText).toBe("I'll read the file. Done.");
  });

  test("error-result: emits provider_error", () => {
    const result = replayFixtureFile(join(fixtures, "error-result.ndjson"), "trn_err");

    expect(result.unparseable).toEqual([]);
    const err = result.events.find((e) => e.type === "error");
    expect(err).toEqual({
      type: "error",
      code: "provider_error",
      message: "rate_limit: too many requests",
    });
  });

  test("unparseable lines are collected, not thrown", () => {
    const result = replayNdjson("not-json\n{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"x\"}\n", "trn_x");
    expect(result.unparseable).toEqual(["not-json"]);
    expect(result.state.nativeId).toBe("x");
  });

  test("partial stream_event deltas are preferred over assistant snapshots", () => {
    const result = replayFixtureFile(join(fixtures, "partial-turn.ndjson"), "trn_partial");
    expect(result.assistantText).toBe("Hi there.");
    expect(result.events.filter((e) => e.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", turnId: "trn_partial", text: "Hi " },
      { type: "assistant.delta", turnId: "trn_partial", text: "there." },
    ]);
  });

  test("unwrapped content_block_delta streams tokens", () => {
    const result = replayNdjson(
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello " },
      }) +
        "\n" +
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "there." },
        }) +
        "\n",
      "trn_unwrap",
    );
    expect(result.assistantText).toBe("Hello there.");
    expect(result.events.filter((e) => e.type === "assistant.delta")).toHaveLength(2);
  });
});
