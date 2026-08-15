import { describe, expect, test } from "bun:test";
import { formatDayShort, formatTokenCount, formatTokens } from "./tokenFormat.ts";

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
