/**
 * File-type presentation for changed-file rows.
 *
 * A short extension badge rather than an icon set: it reads at a glance, needs
 * no icon font, and degrades honestly for a file type nobody anticipated —
 * an unknown extension still shows its own extension rather than a generic
 * blank page.
 */

const COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#f7df1e",
  jsx: "#f7df1e",
  mjs: "#f7df1e",
  cjs: "#f7df1e",
  json: "#8a8a8a",
  css: "#663399",
  scss: "#c6538c",
  html: "#e34c26",
  md: "#519aba",
  mdx: "#519aba",
  rs: "#dea584",
  go: "#00add8",
  py: "#3572a5",
  rb: "#cc342d",
  java: "#b07219",
  kt: "#a97bff",
  swift: "#f05138",
  c: "#555555",
  h: "#555555",
  cpp: "#f34b7d",
  cs: "#178600",
  php: "#4f5d95",
  sh: "#89e051",
  bash: "#89e051",
  zsh: "#89e051",
  yml: "#cb171e",
  yaml: "#cb171e",
  toml: "#9c4221",
  sql: "#e38c00",
  svg: "#ffb13b",
  png: "#a074c4",
  jpg: "#a074c4",
  jpeg: "#a074c4",
  gif: "#a074c4",
  lock: "#8a8a8a",
};

/** Files whose whole name is the identity, so the "extension" is misleading. */
const WHOLE_NAME: Record<string, { label: string; color: string }> = {
  dockerfile: { label: "dock", color: "#2496ed" },
  makefile: { label: "make", color: "#427819" },
  ".gitignore": { label: "git", color: "#f1502f" },
  ".env": { label: "env", color: "#edd54c" },
};

export interface FileKind {
  /** Short badge text, already trimmed to something that fits. */
  label: string;
  color: string;
}

export function fileKind(path: string): FileKind {
  const name = (path.split("/").pop() ?? path).toLowerCase();

  const whole = WHOLE_NAME[name];
  if (whole) return whole;

  // A leading dot is part of the name, not an extension separator.
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (!ext) return { label: name.slice(0, 4) || "file", color: "#6b7280" };

  return { label: ext.slice(0, 4), color: COLORS[ext] ?? "#6b7280" };
}

/** Single-letter status, matching git's own vocabulary. */
export function statusLabel(status: string): { text: string; tone: string } | null {
  switch (status) {
    case "A":
      return { text: "A", tone: "is-added" };
    case "D":
      return { text: "D", tone: "is-deleted" };
    case "R":
      return { text: "R", tone: "is-renamed" };
    // Modified is the common case; labelling it adds noise to every row.
    default:
      return null;
  }
}
