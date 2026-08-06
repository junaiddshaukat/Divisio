import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitNdjson } from "@divisio/adapters";
import { normalizeGeminiStreamLine } from "./normalize.ts";

const fixtures = join(import.meta.dir, "../../fixtures/gemini");

describe("Gemini stream normalizer", () => {
  test("text-turn: init + deltas", () => {
    const raw = readFileSync(join(fixtures, "text-turn.ndjson"), "utf8");
    let state = { nativeId: null as string | null, seenTools: new Set<string>() };
    let text = "";
    for (const line of splitNdjson(raw)) {
      const result = normalizeGeminiStreamLine(JSON.parse(line), "trn_gem", state);
      state = result.state;
      text += result.text;
    }
    expect(state.nativeId).toBe("gem-sess-1");
    expect(text).toBe("Hello world");
  });
});
