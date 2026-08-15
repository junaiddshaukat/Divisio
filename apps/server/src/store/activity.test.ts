import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_RANGE_DAYS,
  assembleActivityStats,
  computeStreaks,
  localDateKey,
  shiftDateKey,
} from "./activity.ts";

describe("localDateKey / shiftDateKey", () => {
  test("round-trips a fixed local date", () => {
    const key = localDateKey(new Date(2026, 7, 6, 15, 30));
    expect(key).toBe("2026-08-06");
    expect(shiftDateKey(key, -1)).toBe("2026-08-05");
    expect(shiftDateKey(key, 1)).toBe("2026-08-07");
  });
});

describe("computeStreaks", () => {
  test("empty activity is zero", () => {
    expect(computeStreaks([], "2026-08-06")).toEqual({
      currentStreak: 0,
      longestStreak: 0,
      activeDays: 0,
    });
  });

  test("current streak ends today", () => {
    const r = computeStreaks(["2026-08-04", "2026-08-05", "2026-08-06"], "2026-08-06");
    expect(r.currentStreak).toBe(3);
    expect(r.longestStreak).toBe(3);
    expect(r.activeDays).toBe(3);
  });

  test("yesterday still counts when today is empty", () => {
    const r = computeStreaks(["2026-08-04", "2026-08-05"], "2026-08-06");
    expect(r.currentStreak).toBe(2);
  });

  test("gap breaks longest and current", () => {
    const r = computeStreaks(["2026-08-01", "2026-08-02", "2026-08-05", "2026-08-06"], "2026-08-06");
    expect(r.currentStreak).toBe(2);
    expect(r.longestStreak).toBe(2);
    expect(r.activeDays).toBe(4);
  });
});

describe("assembleActivityStats", () => {
  test("fills a contiguous range and sums totals", () => {
    const stats = assembleActivityStats({
      turnDays: [
        { date: "2026-08-05", turns: 2 },
        { date: "2026-08-06", turns: 1 },
      ],
      messageDays: [{ date: "2026-08-06", messages: 3 }],
      providers: [
        { kind: "claude", turns: 2 },
        { kind: "cursor", turns: 1 },
      ],
      threads: 4,
      projects: 2,
      filesTouched: 7,
      todayKey: "2026-08-06",
      rangeDays: 7,
    });

    expect(stats.rangeDays).toBe(7);
    expect(stats.days).toHaveLength(7);
    expect(stats.days[0]!.date).toBe("2026-07-31");
    expect(stats.days.at(-1)!.date).toBe("2026-08-06");
    expect(stats.totals.turns).toBe(3);
    expect(stats.totals.messages).toBe(3);
    expect(stats.totals.threads).toBe(4);
    expect(stats.totals.projects).toBe(2);
    expect(stats.totals.filesTouched).toBe(7);
    expect(stats.totals.currentStreak).toBe(2);
    expect(stats.providers[0]!.kind).toBe("claude");
  });

  test("default range is 53 weeks", () => {
    const stats = assembleActivityStats({
      turnDays: [],
      messageDays: [],
      providers: [],
      threads: 0,
      projects: 0,
      filesTouched: 0,
      todayKey: "2026-08-06",
    });
    expect(stats.rangeDays).toBe(ACTIVITY_RANGE_DAYS);
    expect(stats.days).toHaveLength(ACTIVITY_RANGE_DAYS);
  });
});
