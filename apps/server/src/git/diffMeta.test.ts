import { describe, expect, test } from "bun:test";
import { attachLineCounts, parseNameStatusLine, parseNumstatLine } from "./diffMeta.ts";

describe("parseNumstatLine", () => {
  test("counts added and deleted lines", () => {
    expect(parseNumstatLine("19\t9\tapps/web/src/App.tsx")).toEqual({
      path: "apps/web/src/App.tsx",
      additions: 19,
      deletions: 9,
    });
  });

  test("binary files count as zero", () => {
    expect(parseNumstatLine("-\t-\ticon.png")).toEqual({
      path: "icon.png",
      additions: 0,
      deletions: 0,
    });
  });

  test("rename brace form uses the new path", () => {
    expect(parseNumstatLine("1\t0\tsrc/{old.ts => new.ts}")).toEqual({
      path: "src/new.ts",
      additions: 1,
      deletions: 0,
    });
  });
});

describe("parseNameStatusLine", () => {
  test("modified and added", () => {
    expect(parseNameStatusLine("M\tsrc/a.ts")).toEqual({ path: "src/a.ts", status: "M" });
    expect(parseNameStatusLine("A\tnew.ts")).toEqual({ path: "new.ts", status: "A" });
  });

  test("rename takes the destination path", () => {
    expect(parseNameStatusLine("R100\told.ts\tnew.ts")).toEqual({ path: "new.ts", status: "R" });
  });
});

describe("attachLineCounts", () => {
  test("merges by path without dropping files that have no numstat", () => {
    const files = [
      { path: "a.ts", status: "M" as const },
      { path: "b.ts", status: "A" as const },
    ];
    const counts = new Map([["a.ts", { additions: 2, deletions: 1 }]]);
    expect(attachLineCounts(files, counts)).toEqual([
      { path: "a.ts", status: "M", additions: 2, deletions: 1 },
      { path: "b.ts", status: "A" },
    ]);
  });
});
