import { useMemo, useState } from "react";

/** One rendered line of a unified diff. */
export interface DiffLine {
  kind: "meta" | "hunk" | "add" | "del" | "ctx" | "other";
  text: string;
}

/** Split a unified patch into typed lines for colored rendering. */
export function parseDiffLines(patch: string): DiffLine[] {
  return patch.split("\n").map((text) => {
    if (
      text.startsWith("diff --git") ||
      text.startsWith("index ") ||
      text.startsWith("--- ") ||
      text.startsWith("+++ ") ||
      text.startsWith("new file") ||
      text.startsWith("deleted file") ||
      text.startsWith("similarity") ||
      text.startsWith("rename ")
    ) {
      return { kind: "meta" as const, text };
    }
    if (text.startsWith("@@")) return { kind: "hunk" as const, text };
    if (text.startsWith("+")) return { kind: "add" as const, text };
    if (text.startsWith("-")) return { kind: "del" as const, text };
    if (text.startsWith(" ") || text === "") return { kind: "ctx" as const, text };
    return { kind: "other" as const, text };
  });
}

export function countDiffStats(patch: string | null | undefined): { adds: number; dels: number } {
  if (!patch) return { adds: 0, dels: 0 };
  let adds = 0;
  let dels = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) dels += 1;
  }
  return { adds, dels };
}

type Segment =
  | { type: "lines"; lines: DiffLine[]; start: number }
  | { type: "collapse"; count: number; lines: DiffLine[]; start: number };

/**
 * Collapse long runs of unchanged context — same idea as a review UI that
 * only shows the interesting edges of each hunk.
 */
export function segmentDiffLines(lines: DiffLine[], keep = 2, collapseAbove = 4): Segment[] {
  const meaningful = lines.filter((l) => l.kind !== "meta");
  const out: Segment[] = [];
  let i = 0;
  while (i < meaningful.length) {
    const line = meaningful[i]!;
    if (line.kind !== "ctx") {
      const start = i;
      const chunk: DiffLine[] = [];
      while (i < meaningful.length && meaningful[i]!.kind !== "ctx") {
        chunk.push(meaningful[i]!);
        i += 1;
      }
      out.push({ type: "lines", lines: chunk, start });
      continue;
    }
    const start = i;
    const run: DiffLine[] = [];
    while (i < meaningful.length && meaningful[i]!.kind === "ctx") {
      run.push(meaningful[i]!);
      i += 1;
    }
    if (run.length <= collapseAbove) {
      out.push({ type: "lines", lines: run, start });
    } else {
      const head = run.slice(0, keep);
      const mid = run.slice(keep, run.length - keep);
      const tail = run.slice(run.length - keep);
      if (head.length) out.push({ type: "lines", lines: head, start });
      out.push({ type: "collapse", count: mid.length, lines: mid, start: start + keep });
      if (tail.length) out.push({ type: "lines", lines: tail, start: start + keep + mid.length });
    }
  }
  return out;
}

/**
 * Line-colored unified diff with collapsed unmodified stretches.
 */
export function DiffHunkView({ patch, compactMeta = true }: { patch: string | null; compactMeta?: boolean }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const lines = useMemo(() => (patch ? parseDiffLines(patch) : []), [patch]);
  const segments = useMemo(() => segmentDiffLines(lines), [lines]);

  if (!patch) {
    return (
      <pre className="diff-hunks">
        <span className="diff-line meta">No patch text.</span>
      </pre>
    );
  }

  const meta = compactMeta ? [] : lines.filter((l) => l.kind === "meta");

  return (
    <pre className="diff-hunks" aria-label="Diff">
      {meta.map((line, i) => (
        <span key={`m-${i}`} className={`diff-line ${line.kind}`}>
          {line.text || " "}
          {"\n"}
        </span>
      ))}
      {segments.map((seg, i) => {
        if (seg.type === "lines") {
          return seg.lines.map((line, j) => (
            <span key={`${i}-${j}`} className={`diff-line ${line.kind}`}>
              {line.text || " "}
              {"\n"}
            </span>
          ));
        }
        if (expanded.has(i)) {
          return (
            <span key={i}>
              <button
                type="button"
                className="diff-collapse"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    next.delete(i);
                    return next;
                  })
                }
              >
                Hide {seg.count} unmodified lines
              </button>
              {seg.lines.map((line, j) => (
                <span key={`${i}-x-${j}`} className={`diff-line ${line.kind}`}>
                  {line.text || " "}
                  {"\n"}
                </span>
              ))}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            className="diff-collapse"
            onClick={() => setExpanded((prev) => new Set(prev).add(i))}
          >
            {seg.count} unmodified lines
          </button>
        );
      })}
    </pre>
  );
}
