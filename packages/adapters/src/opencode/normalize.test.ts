import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeOpenCodeStreamLine } from "./normalize.ts";
import { splitNdjson } from "../testkit/replay.ts";

const fixtures = join(import.meta.dir, "../../fixtures/opencode");

describe("OpenCode stream normalizer", () => {
  test("text-turn: deltas accumulate; tools finish", () => {
    const raw = readFileSync(join(fixtures, "text-turn.ndjson"), "utf8");
    let state = { nativeId: null as string | null, textLens: new Map<string, number>() };
    const events = [];
    let text = "";
    for (const line of splitNdjson(raw)) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const result = normalizeOpenCodeStreamLine(msg, "trn_oc", state);
      state = result.state;
      text += result.text;
      events.push(...result.events);
    }
    expect(state.nativeId).toBe("oc-sess-1");
    expect(text).toBe("Hello from OpenCode");
    expect(events.some((e) => e.type === "tool.finished")).toBe(true);
  });
});
