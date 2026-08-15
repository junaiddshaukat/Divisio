import { describe, expect, test } from "bun:test";
import { assembleUsageStats, normalizeUsageRange, reportedTokens } from "./usage.ts";

describe("normalizeUsageRange", () => {
  test("accepts 7 / 30 / 90 and defaults otherwise", () => {
    expect(normalizeUsageRange(7)).toBe(7);
    expect(normalizeUsageRange(30)).toBe(30);
    expect(normalizeUsageRange(90)).toBe(90);
    expect(normalizeUsageRange(14)).toBe(30);
    expect(normalizeUsageRange(undefined)).toBe(30);
  });
});

describe("reportedTokens", () => {
  test("sums disjoint parts and does not add totalTokens on top", () => {
    expect(
      reportedTokens({
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 1000,
        cacheWriteTokens: 80,
        totalTokens: 9999,
      }),
    ).toBe(1096);
  });

  test("falls back to totalTokens when parts are absent", () => {
    expect(reportedTokens({ totalTokens: 40 })).toBe(40);
  });
});

describe("assembleUsageStats", () => {
  test("empty log fills a contiguous zero series", () => {
    const stats = assembleUsageStats({
      started: [],
      usage: [],
      rangeDays: 7,
      todayKey: "2026-08-16",
    });
    expect(stats.from).toBe("2026-08-10");
    expect(stats.to).toBe("2026-08-16");
    expect(stats.days).toHaveLength(7);
    expect(stats.days.every((d) => d.tokens === 0 && d.meteredTurns === 0)).toBe(true);
    expect(stats.totals).toEqual({
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      meteredTurns: 0,
      unmeteredTurns: 0,
    });
  });

  test("meters usage and marks started turns without usage as unmetered", () => {
    const stats = assembleUsageStats({
      started: [
        { date: "2026-08-16", turnId: "trn_claude", provider: "claude" },
        { date: "2026-08-16", turnId: "trn_grok", provider: "grok" },
        { date: "2026-07-01", turnId: "trn_old", provider: "claude" },
      ],
      usage: [
        {
          date: "2026-08-16",
          turnId: "trn_claude",
          provider: "claude",
          inputTokens: 12,
          outputTokens: 4,
          cacheReadTokens: 100,
        },
      ],
      rangeDays: 7,
      todayKey: "2026-08-16",
    });

    expect(stats.totals.tokens).toBe(116);
    expect(stats.totals.inputTokens).toBe(12);
    expect(stats.totals.outputTokens).toBe(4);
    expect(stats.totals.cacheReadTokens).toBe(100);
    expect(stats.totals.meteredTurns).toBe(1);
    expect(stats.totals.unmeteredTurns).toBe(1);
    expect(stats.days.at(-1)).toEqual({
      date: "2026-08-16",
      tokens: 116,
      meteredTurns: 1,
    });
    expect(stats.providers).toEqual([
      { kind: "claude", tokens: 116, meteredTurns: 1, unmeteredTurns: 0 },
      { kind: "grok", tokens: 0, meteredTurns: 0, unmeteredTurns: 1 },
    ]);
  });

  test("joins provider from turn.started when usage omitted it", () => {
    const stats = assembleUsageStats({
      started: [{ date: "2026-08-16", turnId: "trn_a", provider: "claude" }],
      usage: [{ date: "2026-08-16", turnId: "trn_a", inputTokens: 8, outputTokens: 2 }],
      rangeDays: 7,
      todayKey: "2026-08-16",
    });
    expect(stats.providers[0]).toEqual({
      kind: "claude",
      tokens: 10,
      meteredTurns: 1,
      unmeteredTurns: 0,
    });
  });

  test("drops events outside the window", () => {
    const stats = assembleUsageStats({
      started: [{ date: "2026-07-01", turnId: "trn_old", provider: "claude" }],
      usage: [{ date: "2026-07-01", turnId: "trn_old", provider: "claude", totalTokens: 5000 }],
      rangeDays: 7,
      todayKey: "2026-08-16",
    });
    expect(stats.totals.tokens).toBe(0);
    expect(stats.totals.meteredTurns).toBe(0);
    expect(stats.providers).toEqual([]);
  });
});
