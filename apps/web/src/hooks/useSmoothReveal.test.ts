import { describe, expect, test } from "bun:test";
import { nextRevealLength } from "./useSmoothReveal.ts";

describe("nextRevealLength", () => {
  test("starts catching up from empty instead of jumping to the full chunk", () => {
    expect(nextRevealLength(0, 12)).toBe(2);
    expect(nextRevealLength(0, 200)).toBeGreaterThan(0);
    expect(nextRevealLength(0, 200)).toBeLessThan(200);
  });

  test("does not overshoot", () => {
    expect(nextRevealLength(10, 11)).toBe(11);
    expect(nextRevealLength(20, 20)).toBe(20);
  });
});
