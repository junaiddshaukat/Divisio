import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { replayFixtureFile } from "../testkit/replay.ts";

const fixtures = join(import.meta.dir, "../../fixtures/qwen");

describe("Qwen stream (Claude-compatible fixtures)", () => {
  test("text-turn: init + assistant text", () => {
    const result = replayFixtureFile(join(fixtures, "text-turn.ndjson"), "trn_qwen");
    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("qwen-sess-1");
    expect(result.assistantText).toBe("Hello from Qwen");
  });

  test("session_start + stream_event tokens, snapshot not double-counted", () => {
    const result = replayFixtureFile(join(fixtures, "partial-turn.ndjson"), "trn_qwen_partial");
    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("qwen-sess-partial");
    expect(result.assistantText).toBe("Hello from Qwen.");
    expect(result.events.filter((e) => e.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", turnId: "trn_qwen_partial", text: "Hello " },
      { type: "assistant.delta", turnId: "trn_qwen_partial", text: "from Qwen." },
    ]);
  });
});
