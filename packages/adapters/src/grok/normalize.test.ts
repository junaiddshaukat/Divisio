import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { replayFixtureFile } from "../testkit/replay.ts";

const fixtures = join(import.meta.dir, "../../fixtures/grok");

describe("Grok stream (Messages JSON fixtures)", () => {
  test("text-turn: skips thinking, emits text delta", () => {
    const result = replayFixtureFile(join(fixtures, "text-turn.ndjson"), "trn_grok");
    expect(result.unparseable).toEqual([]);
    expect(result.state.nativeId).toBe("grok-sess-1");
    expect(result.assistantText).toBe("Hi from Grok");
  });
});
