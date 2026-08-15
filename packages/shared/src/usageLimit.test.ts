import { describe, expect, test } from "bun:test";
import { looksLikeUsageLimit } from "./usageLimit.ts";

describe("looksLikeUsageLimit", () => {
  test("matches Claude-style rate_limit errors", () => {
    expect(looksLikeUsageLimit({ code: "rate_limit", message: "too many requests" })).toBe(true);
    expect(looksLikeUsageLimit({ message: "rate_limit: too many requests" })).toBe(true);
  });

  test("matches quota / extra-usage copy without inventing a percent", () => {
    expect(looksLikeUsageLimit({ message: "You've hit your usage limit" })).toBe(true);
    expect(looksLikeUsageLimit({ message: "out of extra usage" })).toBe(true);
    expect(looksLikeUsageLimit({ code: "quota_exceeded" })).toBe(true);
  });

  test("does not treat generic failures as quota", () => {
    expect(looksLikeUsageLimit({ message: "file not found" })).toBe(false);
    expect(looksLikeUsageLimit({ code: "provider_error", message: "segfault" })).toBe(false);
    expect(looksLikeUsageLimit({})).toBe(false);
  });
});
