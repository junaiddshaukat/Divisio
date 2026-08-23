/**
 * Which lines of a file an agent actually touched, in the file's own
 * coordinates.
 *
 * A unified diff describes an edit; an editor needs line numbers. This walks
 * the hunk headers to convert one into the other, so opening a file after a
 * turn can point straight at what changed instead of dropping the user at the
 * top of a thousand-line file to find it themselves.
 */

export interface ChangedRange {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  kind: "added" | "modified";
}

export interface FileChangeMarks {
  ranges: ChangedRange[];
  /** Lines whose predecessor was deleted, for a gutter marker. */
  deletedAt: number[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Pull the section of a multi-file patch belonging to one path.
 *
 * Paths are matched on the `+++ b/<path>` line rather than `diff --git`, since
 * a rename makes those two disagree and the new path is the one the editor
 * will open.
 */
export function patchForPath(patch: string, path: string): string | null {
  const lines = patch.split("\n");
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("+++ ")) continue;
    const target = line.slice(4).replace(/^b\//, "").trim();
    if (target !== path) continue;
    start = i + 1;
    for (let j = start; j < lines.length; j += 1) {
      if (lines[j]!.startsWith("diff --git ")) {
        end = j;
        break;
      }
    }
    break;
  }

  if (start === -1) return null;
  return lines.slice(start, end).join("\n");
}

/**
 * Convert one file's hunks into line ranges in the post-edit file.
 *
 * Consecutive added lines collapse into a single range so the editor draws one
 * band per edit rather than one per line. A run that sits directly after
 * removed lines is reported as `modified`, which is what a replacement looks
 * like in a unified diff and reads better than "added" in the gutter.
 */
export function changedRangesFromPatch(filePatch: string): FileChangeMarks {
  const ranges: ChangedRange[] = [];
  const deletedAt: number[] = [];

  let newLine = 0;
  let runStart = 0;
  let runEnd = 0;
  let runFollowsDelete = false;
  let sawDeleteSinceContext = false;

  const flush = () => {
    if (runStart === 0) return;
    ranges.push({
      startLine: runStart,
      endLine: runEnd,
      kind: runFollowsDelete ? "modified" : "added",
    });
    runStart = 0;
    runEnd = 0;
    runFollowsDelete = false;
  };

  for (const line of filePatch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      flush();
      newLine = Number(hunk[1]);
      sawDeleteSinceContext = false;
      continue;
    }
    if (newLine === 0) continue;

    // `\ No newline at end of file` is metadata, not content.
    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      if (runStart === 0) {
        runStart = newLine;
        runFollowsDelete = sawDeleteSinceContext;
      }
      runEnd = newLine;
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      // A deletion consumes no line in the new file; mark where it happened so
      // a pure removal is still visible.
      if (runStart === 0) deletedAt.push(Math.max(1, newLine));
      sawDeleteSinceContext = true;
      continue;
    }

    // Context line (or an empty trailing line, which git writes bare).
    flush();
    sawDeleteSinceContext = false;
    newLine += 1;
  }

  flush();
  return { ranges, deletedAt: [...new Set(deletedAt)] };
}

/** Convenience: ranges for one path out of a whole-turn patch. */
export function changedRangesForFile(
  patch: string | null | undefined,
  path: string,
): FileChangeMarks {
  if (!patch) return { ranges: [], deletedAt: [] };
  const filePatch = patchForPath(patch, path);
  if (!filePatch) return { ranges: [], deletedAt: [] };
  return changedRangesFromPatch(filePatch);
}
