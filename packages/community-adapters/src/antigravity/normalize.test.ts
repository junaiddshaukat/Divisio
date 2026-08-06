import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitNdjson } from "@divisio/adapters";
import { normalizeAntigravityStreamLine } from "./normalize.ts";

const fixtures = join(import.meta.dir, "../../fixtures/antigravity");

describe("Antigravity stream normalizer", () => {
  test("text-turn: deltas + tool finish", () => {
    const raw = readFileSync(join(fixtures, "text-turn.ndjson"), "utf8");
    let state = {
      nativeId: null as string | null,
      activeTools: new Map<number, string>(),
      toolSeq: 0,
      hadAssistantText: false,
    };
    const events = [];
    let text = "";
    for (const line of splitNdjson(raw)) {
      const result = normalizeAntigravityStreamLine(JSON.parse(line), "trn_agy", state);
      state = result.state;
      text += result.text;
      events.push(...result.events);
    }
    expect(state.nativeId).toBe("agy-sess-1");
    expect(text).toBe("Rewriting history.\n");
    expect(events.some((e) => e.type === "tool.finished")).toBe(true);
  });
});
