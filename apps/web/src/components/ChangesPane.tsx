import { useEffect, useMemo, useState } from "react";
import type { DiffFileEntry } from "@divisio/contracts";
import { countDiffStats, DiffHunkView } from "./DiffHunkView.tsx";
import { Button } from "./ui/Button.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./ui/icons.ts";

export type ChangesScope = "working" | "branch" | "turn";

interface Props {
  scope: ChangesScope;
  turnId: string | null;
  turnOptions: Array<{ turnId: string; label: string }>;
  files: DiffFileEntry[];
  patch: string | null;
  status: string;
  detail?: string;
  busy?: boolean;
  preferredPath?: string | null;
  branch?: string | null;
  onScopeChange(scope: ChangesScope): void;
  onTurnChange?(turnId: string): void;
  onRestore?(turnId: string): Promise<void>;
  /** Working-tree commit; pass `paths` for partial staging. */
  onCommit?(message: string, paths?: string[]): Promise<{ ok: boolean; detail?: string }>;
}

/** Split a unified git patch into per-file hunks keyed by the `b/` path. */
export function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = patch.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (m?.[2]) map.set(m[2], part);
  }
  return map;
}

function fileBase(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function fileDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/**
 * Stacked per-file diffs with collapsed unmodified stretches — stays readable
 * when dozens of files change, instead of one endless raw patch.
 */
export function ChangesPane({
  scope,
  turnId,
  turnOptions,
  files,
  patch,
  status,
  detail,
  busy,
  preferredPath,
  branch,
  onScopeChange,
  onTurnChange,
  onRestore,
  onCommit,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitHint, setCommitHint] = useState<string | null>(null);

  const byFile = useMemo(() => (patch ? splitPatchByFile(patch) : new Map<string, string>()), [patch]);
  const totals = useMemo(() => countDiffStats(patch), [patch]);

  const fileStats = useMemo(() => {
    const map = new Map<string, { adds: number; dels: number }>();
    for (const f of files) {
      map.set(f.path, countDiffStats(byFile.get(f.path)));
    }
    return map;
  }, [files, byFile]);

  useEffect(() => {
    setConfirming(false);
    setCommitHint(null);
    setStaged(new Set(files.map((f) => f.path)));
    // Many files: start collapsed except the preferred / first — keeps the panel short.
    if (files.length > 6) {
      const open = preferredPath && files.some((f) => f.path === preferredPath) ? preferredPath : files[0]?.path;
      setCollapsed(new Set(files.map((f) => f.path).filter((p) => p !== open)));
    } else {
      setCollapsed(new Set());
    }
  }, [scope, turnId, files, preferredPath]);

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleStage = (path: string) => {
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const restore = async () => {
    if (!onRestore || !turnId) return;
    setRestoreBusy(true);
    try {
      await onRestore(turnId);
      setConfirming(false);
    } finally {
      setRestoreBusy(false);
    }
  };

  const commit = async () => {
    if (!onCommit) return;
    const msg = message.trim();
    if (!msg) return;
    const paths = [...staged];
    if (paths.length === 0) {
      setCommitHint("Select at least one file");
      return;
    }
    setCommitBusy(true);
    setCommitHint(null);
    try {
      const all = paths.length === files.length;
      const res = await onCommit(msg, all ? undefined : paths);
      if (res.ok) {
        setMessage("");
        setCommitHint(all ? "Committed." : `Committed ${paths.length} file(s).`);
      } else {
        setCommitHint(res.detail ?? "Commit failed");
      }
    } catch (err) {
      setCommitHint(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitBusy(false);
    }
  };

  return (
    <section className="changes-pane" aria-label="Changes">
      <div className="changes-toolbar">
        <select
          value={scope}
          onChange={(e) => onScopeChange(e.target.value as ChangesScope)}
          aria-label="Diff scope"
        >
          <option value="working">Working tree</option>
          <option value="branch">Branch{branch ? ` (${branch})` : ""}</option>
          <option value="turn" disabled={turnOptions.length === 0}>
            Turn
          </option>
        </select>
        {scope === "turn" && turnOptions.length > 0 && (
          <select
            value={turnId ?? turnOptions[0]?.turnId ?? ""}
            onChange={(e) => onTurnChange?.(e.target.value)}
            aria-label="Turn"
          >
            {turnOptions.map((t) => (
              <option key={t.turnId} value={t.turnId}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        {files.length > 0 && (
          <span className="changes-stats" title={`${files.length} files`}>
            <span className="adds">+{totals.adds}</span>
            <span className="dels">−{totals.dels}</span>
            <span className="meta">{files.length} files</span>
          </span>
        )}
      </div>

      <div className="changes-stream">
        {status !== "ready" && status !== "missing" && (
          <div className="banner tight">{detail ?? status}</div>
        )}
        {busy && <p className="muted pad">Loading diff…</p>}
        {!busy && files.length === 0 && (
          <p className="muted pad">
            {scope === "working"
              ? "Working tree is clean."
              : scope === "branch"
                ? "No branch changes vs base."
                : status === "missing"
                  ? "No checkpoint diff for this turn."
                  : "No file changes for this turn."}
          </p>
        )}

        {files.map((f) => {
          const filePatch = byFile.get(f.path) ?? null;
          const stats = fileStats.get(f.path) ?? { adds: 0, dels: 0 };
          const isCollapsed = collapsed.has(f.path);
          const dir = fileDir(f.path);
          return (
            <article key={f.path} className={`changes-file${isCollapsed ? " is-collapsed" : ""}`}>
              <header className="changes-file-head">
                {scope === "working" && onCommit && (
                  <input
                    type="checkbox"
                    checked={staged.has(f.path)}
                    onChange={() => toggleStage(f.path)}
                    aria-label={`Stage ${f.path}`}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                <button
                  type="button"
                  className="changes-file-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollapse(f.path)}
                >
                  {isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                  <span className={`diff-status status-${f.status}`}>{f.status}</span>
                  <span className="changes-file-name" title={f.path}>
                    {dir ? <span className="changes-file-dir">{dir}/</span> : null}
                    <span className="changes-file-base">{fileBase(f.path)}</span>
                  </span>
                  <span className="changes-file-counts">
                    {stats.adds > 0 && <span className="adds">+{stats.adds}</span>}
                    {stats.dels > 0 && <span className="dels">−{stats.dels}</span>}
                  </span>
                </button>
              </header>
              {!isCollapsed && (
                <div className="changes-file-body">
                  {filePatch ? (
                    <DiffHunkView patch={filePatch} />
                  ) : (
                    <p className="muted pad tight">No patch for this file.</p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="changes-foot">
        {onRestore && scope === "turn" && turnId && status === "ready" && files.length > 0 && (
          <div className="changes-restore">
            {confirming ? (
              <>
                <span className="hint danger">Overwrite the working tree with the state before this turn?</span>
                <Button variant="danger" size="sm" disabled={restoreBusy} onClick={() => void restore()}>
                  {restoreBusy ? "Restoring…" : "Restore"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Restore turn
              </Button>
            )}
          </div>
        )}

        {scope === "working" && onCommit && files.length > 0 && (
          <div className="changes-commit">
            <input
              placeholder={
                staged.size === files.length
                  ? "Commit message (all files)"
                  : `Commit message (${staged.size} selected)`
              }
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && message.trim() && void commit()}
              disabled={commitBusy}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!message.trim() || commitBusy || staged.size === 0}
              onClick={() => void commit()}
            >
              {commitBusy ? "Committing…" : "Commit"}
            </Button>
          </div>
        )}
        {commitHint && (
          <span className={`hint${commitHint.includes("fail") || commitHint.includes("Select") ? " danger" : ""}`}>
            {commitHint}
          </span>
        )}
      </div>
    </section>
  );
}
