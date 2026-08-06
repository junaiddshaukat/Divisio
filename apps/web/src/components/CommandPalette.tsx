import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LaneView, ProjectView, ThreadView } from "@divisio/contracts";
import { statusOf } from "../status.ts";
import { BranchIcon, ProjectIcon, SearchIcon, ThreadIcon } from "./ui/icons.ts";

/**
 * Command palette (⌘K).
 *
 * Actions are supplied by the caller; navigation targets (threads, lanes,
 * projects) are derived here, because they are pure data and rebuilding that
 * list in App would mean keeping two copies in step.
 *
 * Ranking is field-ordinal rather than fuzzy: a title match always outranks a
 * subtitle match. Fuzzy scoring inverts that on short queries, which is exactly
 * when people type the fewest characters.
 */

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run(): void;
}

interface Entry {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: ReactNode;
  keys?: string;
  status?: ThreadView["status"];
  run(): void;
}

interface Props {
  open: boolean;
  actions: PaletteAction[];
  onClose(): void;
  /** Optional navigation corpus. Omitted callers keep the actions-only palette. */
  projects?: ProjectView[];
  threads?: ThreadView[];
  lanes?: LaneView[];
  onOpenThread?(threadId: string): void;
}

function score(query: string, primary: string, secondary?: string): number {
  const q = query.toLowerCase();
  const p = primary.toLowerCase();
  if (p.startsWith(q)) return 1000;
  if (p.includes(q)) return 800;
  const s = secondary?.toLowerCase() ?? "";
  if (s.startsWith(q)) return 600;
  if (s.includes(q)) return 400;
  // Subsequence last, so "adsr" still reaches "add search" without letting
  // loose matches outrank real ones.
  let i = 0;
  for (const ch of p) if (ch === q[i]) i++;
  return i === q.length ? 200 : -1;
}

export function CommandPalette({
  open,
  actions,
  onClose,
  projects = [],
  threads = [],
  lanes = [],
  onOpenThread,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const laneById = new Map(lanes.map((l) => [l.id, l]));

    const navigation: Entry[] = onOpenThread
      ? threads.map((t) => {
          const lane = t.laneId ? laneById.get(t.laneId) : null;
          return {
            id: `thread:${t.id}`,
            label: t.title,
            hint: [projectName.get(t.projectId), t.provider, lane?.branch].filter(Boolean).join(" · "),
            group: "Threads",
            icon: <ThreadIcon />,
            status: t.status,
            run: () => onOpenThread(t.id),
          };
        })
      : [];

    const laneEntries: Entry[] = lanes
      .filter((l) => l.status !== "archived")
      .map((l) => ({
        id: `lane:${l.id}`,
        label: l.title,
        hint: l.branch,
        group: "Lanes",
        icon: <BranchIcon />,
        run: () => {
          const first = threads.find((t) => t.laneId === l.id);
          if (first && onOpenThread) onOpenThread(first.id);
        },
      }));

    const projectEntries: Entry[] = projects.map((p) => ({
      id: `project:${p.id}`,
      label: p.name,
      hint: p.rootPath,
      group: "Projects",
      icon: <ProjectIcon />,
      run: () => {
        const first = threads.find((t) => t.projectId === p.id);
        if (first && onOpenThread) onOpenThread(first.id);
      },
    }));

    return [...actions.map((a) => ({ ...a })), ...navigation, ...laneEntries, ...projectEntries];
  }, [actions, projects, threads, lanes, onOpenThread]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // With no query the user has not said what they want, so show what they
      // can do plus the few most recent threads — not everything.
      return [...entries.filter((e) => !e.id.includes(":")), ...entries.filter((e) => e.id.startsWith("thread:")).slice(0, 6)];
    }
    return entries
      .map((e) => ({ e, s: score(q, e.label, e.hint) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.e);
  }, [entries, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, results.length]);

  if (!open) return null;

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  let lastGroup = "";

  return (
    <div className="palette-backdrop" onClick={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-search">
          <SearchIcon />
          <input
            autoFocus
            className="palette-input"
            placeholder="Search threads, lanes, projects — or run a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd className="composer-hint">esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
          {results.map((entry, i) => {
            const header = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className="palette-row"
                  data-active={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(entry)}
                >
                  {entry.icon}
                  <span className="palette-label">{entry.label}</span>
                  {entry.status && (
                    <span className={`status-dot dot-${statusOf(entry.status).tone}`} aria-hidden />
                  )}
                  {entry.hint && <span className="palette-hint">{entry.hint}</span>}
                  {entry.keys && <kbd className="composer-hint">{entry.keys}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
