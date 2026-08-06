import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitNdjson } from "@divisio/adapters";
import { normalizeCopilotStreamLine } from "./normalize.ts";

const fixtures = join(import.meta.dir, "../../fixtures/copilot");

describe("Copilot stream normalizer", () => {
  test("text-turn: message deltas", () => {
    const raw = readFileSync(join(fixtures, "text-turn.ndjson"), "utf8");
    let state = { nativeId: null as string | null, seenTools: new Set<string>(), hadDelta: false };
    let text = "";
    for (const line of splitNdjson(raw)) {
      const result = normalizeCopilotStreamLine(JSON.parse(line), "trn_cop", state);
      state = result.state;
      text += result.text;
    }
    expect(text).toBe("Hi there");
  });
});
