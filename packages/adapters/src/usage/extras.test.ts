import { describe, expect, test } from "bun:test";
import { parseCursorBubble } from "./cursor.ts";
import {
  flushGrokTranscript,
  initialGrokTranscriptState,
  parseGrokUpdateLine,
} from "./grok.ts";
import { parseOpenCodePart } from "./opencode.ts";
import { parseQwenUsageLine } from "./qwen.ts";
import { processedTokens } from "./transcripts.ts";

function grokLine(opts: {
  sessionId: string;
  totalTokens: number;
  sessionUpdate: string;
  ts: number;
  promptId?: string;
}): string {
  return JSON.stringify({
    timestamp: opts.ts,
    params: {
      sessionId: opts.sessionId,
      update: { sessionUpdate: opts.sessionUpdate },
      _meta: {
        totalTokens: opts.totalTokens,
        agentTimestampMs: opts.ts,
        promptId: opts.promptId ?? "p1",
      },
    },
  });
}

describe("parseGrokUpdateLine", () => {
  test("emits turn deltas from cumulative totalTokens without inventing I/O", () => {
    const state = initialGrokTranscriptState();
    const ts = Date.parse("2026-08-01T12:00:00.000Z");
    expect(parseGrokUpdateLine(grokLine({ sessionId: "s1", totalTokens: 100, sessionUpdate: "agent_message_chunk", ts }), state, "grok-4")).toBeNull();
    const first = parseGrokUpdateLine(
      grokLine({ sessionId: "s1", totalTokens: 140, sessionUpdate: "turn_completed", ts: ts + 1000 }),
      state,
      "grok-4",
    );
    expect(first).toMatchObject({
      provider: "grok",
      model: "grok-4",
      sessionId: "s1",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 140,
    });
    expect(processedTokens(first!)).toBe(140);

    parseGrokUpdateLine(
      grokLine({ sessionId: "s1", totalTokens: 200, sessionUpdate: "agent_thought_chunk", ts: ts + 2000, promptId: "p2" }),
      state,
      "grok-4",
    );
    const second = parseGrokUpdateLine(
      grokLine({ sessionId: "s1", totalTokens: 250, sessionUpdate: "turn_completed", ts: ts + 3000, promptId: "p2" }),
      state,
      "grok-4",
    );
    expect(second?.totalTokens).toBe(110);
    expect(second?.inputTokens).toBe(0);
    expect(second?.outputTokens).toBe(0);
  });

  test("resets on a compact and flushes a leftover tail", () => {
    const state = initialGrokTranscriptState();
    const ts = Date.parse("2026-08-01T12:00:00.000Z");
    parseGrokUpdateLine(grokLine({ sessionId: "s1", totalTokens: 1000, sessionUpdate: "turn_completed", ts }), state, "grok");
    parseGrokUpdateLine(
      grokLine({ sessionId: "s1", totalTokens: 80, sessionUpdate: "agent_message_chunk", ts: ts + 10_000 }),
      state,
      "grok",
    );
    expect(flushGrokTranscript(state, "grok")?.totalTokens).toBe(80);
  });
});

describe("parseQwenUsageLine", () => {
  test("maps native counters and does not add thoughtsTokens", () => {
    const rec = parseQwenUsageLine(
      JSON.stringify({
        id: "u1",
        timestamp: "2026-08-01T00:00:00.000Z",
        sessionId: "ses_q",
        model: "Qwen3.8-Max",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 5,
        thoughtsTokens: 8,
        totalTokens: 125,
      }),
    );
    expect(rec).toMatchObject({
      provider: "qwen",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
    });
    expect(rec?.totalTokens).toBeUndefined();
    expect(processedTokens(rec!)).toBe(125);
  });

  test("falls back to totalTokens when parts are zero", () => {
    const rec = parseQwenUsageLine(
      JSON.stringify({
        id: "u2",
        timestamp: "2026-08-01T00:00:00.000Z",
        thoughtsTokens: 16,
        totalTokens: 16,
      }),
    );
    expect(rec?.inputTokens).toBe(0);
    expect(rec?.outputTokens).toBe(0);
    expect(rec?.totalTokens).toBe(16);
    expect(processedTokens(rec!)).toBe(16);
  });
});

describe("parseCursorBubble", () => {
  test("reads native bubble tokenCount", () => {
    const rec = parseCursorBubble(
      JSON.stringify({
        bubbleId: "b1",
        createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
        modelName: "gpt-5",
        tokenCount: { inputTokens: 40, outputTokens: 10 },
      }),
      "bubbleId:composer1:b1",
    );
    expect(rec).toMatchObject({
      provider: "cursor",
      model: "gpt-5",
      sessionId: "composer1",
      inputTokens: 40,
      outputTokens: 10,
      dedupeKey: "b1",
    });
    expect(processedTokens(rec!)).toBe(50);
  });

  test("skips bubbles without tokens", () => {
    expect(
      parseCursorBubble(JSON.stringify({ bubbleId: "b2", createdAt: Date.now() }), "bubbleId:c:b2"),
    ).toBeNull();
  });
});

describe("parseOpenCodePart", () => {
  test("maps step-finish tokens including nested cache", () => {
    const rec = parseOpenCodePart(
      {
        type: "step-finish",
        tokens: { input: 30, output: 8, cache: { read: 12, write: 2 } },
      },
      { id: "part1", sessionId: "ses_o", timeCreated: Date.parse("2026-08-01T00:00:00.000Z"), model: "gpt-5" },
    );
    expect(rec).toMatchObject({
      provider: "opencode",
      model: "gpt-5",
      inputTokens: 30,
      outputTokens: 8,
      cacheReadTokens: 12,
      cacheWriteTokens: 2,
      dedupeKey: "part1",
    });
    expect(processedTokens(rec!)).toBe(52);
  });
});
