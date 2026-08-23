import { describe, expect, test } from "bun:test";
import { changedRangesForFile, changedRangesFromPatch, patchForPath } from "./changedRanges.ts";

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
 export {};
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,3 +10,3 @@
 keep
-old line
+new line
 tail
`;

describe("patchForPath", () => {
  test("returns only the requested file's hunks", () => {
    const a = patchForPath(TWO_FILES, "src/a.ts");
    expect(a).toContain("+const y = 2;");
    expect(a).not.toContain("new line");
  });

  test("a path not in the patch returns null", () => {
    expect(patchForPath(TWO_FILES, "src/missing.ts")).toBeNull();
  });
});

describe("changedRangesFromPatch", () => {
  test("a pure insertion is reported at its new line number", () => {
    const marks = changedRangesForFile(TWO_FILES, "src/a.ts");
    expect(marks.ranges).toEqual([{ startLine: 2, endLine: 2, kind: "added" }]);
  });

  test("a replacement is reported as modified, not added", () => {
    // A one-line replacement is a delete plus an add in a unified diff;
    // calling that "added" in the gutter misreads what happened.
    const marks = changedRangesForFile(TWO_FILES, "src/b.ts");
    expect(marks.ranges).toEqual([{ startLine: 11, endLine: 11, kind: "modified" }]);
  });

  test("consecutive additions collapse into one range", () => {
    const patch = `@@ -1,1 +1,4 @@
 head
+one
+two
+three
`;
    expect(changedRangesFromPatch(patch).ranges).toEqual([
      { startLine: 2, endLine: 4, kind: "added" },
    ]);
  });

  test("separate edits stay separate ranges", () => {
    const patch = `@@ -1,6 +1,8 @@
 a
+first
 b
 c
+second
 d
`;
    expect(changedRangesFromPatch(patch).ranges).toEqual([
      { startLine: 2, endLine: 2, kind: "added" },
      { startLine: 5, endLine: 5, kind: "added" },
    ]);
  });

  test("a deletion with no replacement is still marked", () => {
    const patch = `@@ -1,3 +1,2 @@
 keep
-gone
 tail
`;
    const marks = changedRangesFromPatch(patch);
    expect(marks.ranges).toEqual([]);
    expect(marks.deletedAt).toEqual([2]);
  });

  test("line numbers stay correct across multiple hunks", () => {
    const patch = `@@ -1,2 +1,3 @@
 a
+added near top
 b
@@ -40,2 +41,3 @@
 x
+added far down
 y
`;
    expect(changedRangesFromPatch(patch).ranges).toEqual([
      { startLine: 2, endLine: 2, kind: "added" },
      { startLine: 42, endLine: 42, kind: "added" },
    ]);
  });

  test("no-newline markers are metadata, not content", () => {
    const patch = `@@ -1,1 +1,2 @@
 a
+b
\\ No newline at end of file
`;
    expect(changedRangesFromPatch(patch).ranges).toEqual([
      { startLine: 2, endLine: 2, kind: "added" },
    ]);
  });

  test("a missing patch yields no marks rather than throwing", () => {
    expect(changedRangesForFile(null, "x.ts")).toEqual({ ranges: [], deletedAt: [] });
    expect(changedRangesForFile("", "x.ts")).toEqual({ ranges: [], deletedAt: [] });
  });
});
