import { describe, expect, test } from "bun:test";
import { rotateWorkingVerbs, WORKING_VERBS } from "./thinkingPhrases.ts";

describe("working verbs", () => {
  test("there are enough phrases to cycle through a long wait", () => {
    expect(WORKING_VERBS.length).toBeGreaterThanOrEqual(20);
    expect(WORKING_VERBS.length).toBeLessThanOrEqual(50);
    expect(new Set(WORKING_VERBS).size).toBe(WORKING_VERBS.length);
  });

  test("rotate keeps every verb exactly once", () => {
    const rotated = rotateWorkingVerbs(7);
    expect(rotated).toHaveLength(WORKING_VERBS.length);
    expect(new Set(rotated).size).toBe(WORKING_VERBS.length);
    expect(rotated[0]).toBe(WORKING_VERBS[7]);
  });

  test("handoff stays out of the cycle", () => {
    expect(WORKING_VERBS).not.toContain("Handing off");
  });
});
