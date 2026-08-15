import { describe, expect, test } from "bun:test";
import {
  areaPath,
  chartPoints,
  nearestIndex,
  niceMax,
  peakDay,
  polylinePath,
} from "./usageChart.ts";

describe("niceMax", () => {
  test("steps on 1/2/5 so axis labels stay round", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(1610)).toBe(2000);
    expect(niceMax(1000)).toBe(1000);
    expect(niceMax(3)).toBe(5);
  });
});

describe("chart path", () => {
  test("maps days across the inner width and down from the max", () => {
    const pts = chartPoints(
      [
        { date: "2026-08-15", tokens: 0, meteredTurns: 0 },
        { date: "2026-08-16", tokens: 100, meteredTurns: 1 },
      ],
      100,
    );
    expect(pts).toHaveLength(2);
    expect(pts[0]!.y).toBeGreaterThan(pts[1]!.y);
    expect(pts[1]!.x).toBeGreaterThan(pts[0]!.x);
    expect(polylinePath(pts).startsWith("M")).toBe(true);
    expect(areaPath(pts, 200).endsWith("Z")).toBe(true);
  });

  test("nearestIndex picks the closest x", () => {
    const pts = chartPoints(
      [
        { date: "a", tokens: 0, meteredTurns: 0 },
        { date: "b", tokens: 0, meteredTurns: 0 },
        { date: "c", tokens: 0, meteredTurns: 0 },
      ],
      1,
    );
    expect(nearestIndex(pts, pts[0]!.x)).toBe(0);
    expect(nearestIndex(pts, pts[2]!.x)).toBe(2);
  });

  test("peakDay ignores empty days", () => {
    expect(peakDay([{ tokens: 0 }, { tokens: 12 }, { tokens: 4 }])?.tokens).toBe(12);
    expect(peakDay([{ tokens: 0 }])).toBeNull();
  });
});
