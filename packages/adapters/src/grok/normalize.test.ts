import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { replayFixtureFile } from "../testkit/replay.ts";
import { normalizeGrokStreamLine } from "./normalize.ts";

const fixtures = join(import.meta.dir, "../../fixtures/grok");

describe("Grok stream", () => {
  test("Messages JSON fixture still maps through Claude-shaped lines", () => {
    const result = replayFixtureFile(
      join(fixtures, "text-turn.ndjson"),
      "trn_grok",
      normalizeGrokStreamLine,
    );
    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("grok-sess-1");
    expect(result.assistantText).toBe("Hi from Grok");
  });

  test("streaming-json emits token deltas and skips thoughts", () => {
    const result = replayFixtureFile(
      join(fixtures, "streaming-json.ndjson"),
      "trn_grok_stream",
      normalizeGrokStreamLine,
    );
    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("grok-sess-stream");
    expect(result.assistantText).toBe("Hello from Grok.");
    expect(result.events.filter((e) => e.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", turnId: "trn_grok_stream", text: "Hello " },
      { type: "assistant.delta", turnId: "trn_grok_stream", text: "from Grok." },
    ]);
    expect(result.assistantText.includes("keep this off")).toBe(false);
  });
});
