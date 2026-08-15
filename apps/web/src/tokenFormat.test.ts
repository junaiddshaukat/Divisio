import { describe, expect, test } from "bun:test";
import { formatDayShort, formatShare, formatTokenCount, formatTokens } from "./tokenFormat.ts";

describe("formatTokens", () => {
  test("keeps small counts as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(12)).toBe("12");
    expect(formatTokens(999)).toBe("999");
  });

  test("compacts thousands and millions", () => {
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(12_400)).toBe("12.4K");
    expect(formatTokens(1_410_000)).toBe("1.41M");
  });
});

describe("formatTokenCount / formatDayShort", () => {
  test("formats exact counts and calendar days", () => {
    expect(formatTokenCount(1410000)).toBe("1,410,000");
    expect(formatDayShort("2026-08-16")).toBe("Aug 16");
  });
});

describe("formatShare", () => {
  test("returns an em dash when there is no total", () => {
    expect(formatShare(10, 0)).toBe("—");
    expect(formatShare(0, 100)).toBe("—");
  });

  test("rounds ordinary percents without fake precision", () => {
    expect(formatShare(1610, 1610)).toBe("100%");
    expect(formatShare(10, 1610)).toBe("0.6%");
    expect(formatShare(800, 1000)).toBe("80%");
  });
});
