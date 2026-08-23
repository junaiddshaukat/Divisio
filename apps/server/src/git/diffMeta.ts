import type { DiffFileEntry } from "@divisio/contracts";

/**
 * Parse `git diff --name-status` lines (optionally with rename scores).
 */
export function parseNameStatusLine(line: string): DiffFileEntry | null {
  const trimmed = line.trimEnd();
  if (!trimmed) return null;
  const parts = trimmed.split("\t");
  const statusRaw = parts[0] ?? "";
  const char = (statusRaw[0] ?? "?") as DiffFileEntry["status"];
  const status: DiffFileEntry["status"] = ["A", "M", "D", "R"].includes(char) ? char : "?";
  const path = status === "R" ? (parts[2] ?? parts[1] ?? "").trim() : (parts[1] ?? "").trim();
  if (!path) return null;
  return { path, status };
}

/**
 * Parse `git diff --numstat` (`adds\\tdels\\tpath`, or `-\\t-\\tpath` for binary).
 */
export function parseNumstatLine(line: string): { path: string; additions: number; deletions: number } | null {
  const trimmed = line.trimEnd();
  if (!trimmed) return null;
  const tab1 = trimmed.indexOf("\t");
  const tab2 = trimmed.indexOf("\t", tab1 + 1);
  if (tab1 < 0 || tab2 < 0) return null;
  const addRaw = trimmed.slice(0, tab1);
  const delRaw = trimmed.slice(tab1 + 1, tab2);
  let path = trimmed.slice(tab2 + 1).trim();
  if (!path) return null;
  if (path.includes(" => ")) {
    path = path.replace(/\{([^}]+) => ([^}]+)\}/, "$2");
    const arrow = path.split(" => ");
    if (arrow.length > 1) path = arrow[arrow.length - 1]!.trim();
  }
  const additions = addRaw === "-" ? 0 : Number(addRaw);
  const deletions = delRaw === "-" ? 0 : Number(delRaw);
  if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return null;
  return { path, additions, deletions };
}

export function numstatMap(stdout: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of stdout.split("\n")) {
    const row = parseNumstatLine(line);
    if (row) map.set(row.path, { additions: row.additions, deletions: row.deletions });
  }
  return map;
}

export function attachLineCounts(
  files: DiffFileEntry[],
  counts: Map<string, { additions: number; deletions: number }>,
): DiffFileEntry[] {
  return files.map((f) => {
    const n = counts.get(f.path);
    if (!n) return f;
    return { ...f, additions: n.additions, deletions: n.deletions };
  });
}
