import { describe, expect, test } from "bun:test";
import { resolvedLineCounts, sumStoredLineCounts } from "./DiffHunkView.tsx";

describe("resolvedLineCounts", () => {
  test("prefers stored numstat, including zeros", () => {
    expect(resolvedLineCounts({ additions: 19, deletions: 0 })).toEqual({ adds: 19, dels: 0 });
  });

  test("falls back to the patch when the entry has no counts", () => {
    expect(resolvedLineCounts({}, { adds: 2, dels: 1 })).toEqual({ adds: 2, dels: 1 });
  });

  test("omits numbers when neither source exists", () => {
    expect(resolvedLineCounts({})).toBeNull();
  });
});

describe("sumStoredLineCounts", () => {
  test("sums when every file carries both counts", () => {
    expect(
      sumStoredLineCounts([
        { additions: 19, deletions: 9 },
        { additions: 1, deletions: 0 },
      ]),
    ).toEqual({ adds: 20, dels: 9 });
  });

  test("returns null when any file is missing counts", () => {
    expect(sumStoredLineCounts([{ additions: 1, deletions: 0 }, {}])).toBeNull();
  });
});
