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
});
