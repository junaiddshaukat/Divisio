import { useMemo, useState } from "react";
import type { LaneView, PrResult, ProjectView, ThreadView } from "@divisio/contracts";

interface Props {
  lanes: LaneView[];
  projects: ProjectView[];
  threads: ThreadView[];
  busy: boolean;
  onCreate(projectId: string, title: string): Promise<void>;
  onArchive(laneId: string, deleteBranch: boolean, force: boolean): Promise<void>;
  onDiff(laneId: string): void;
  onOpenPr(laneId: string, title: string, commitMessage?: string): Promise<PrResult>;
  onOpenThread(threadId: string): void;
  onNewThread(laneId: string): void;
}

/**
 * The point of the board is answering "what needs me?" without reading every
 * lane. Columns are ordered by how much attention they demand, not by lifecycle
 * order, so anything blocked sits at the left where the eye lands first.
 */
type Column = "blocked" | "working" | "idle" | "setup";

const COLUMNS: { key: Column; label: string; hint: string }[] = [
  { key: "blocked", label: "Needs you", hint: "Waiting on approval or stopped by an error" },
  { key: "working", label: "Working", hint: "An agent is running a turn" },
  { key: "idle", label: "Ready", hint: "Idle and waiting for a prompt" },
  { key: "setup", label: "Preparing", hint: "Installing dependencies" },
];

function columnFor(lane: LaneView, laneThreads: ThreadView[]): Column {
  if (lane.status === "preparing") return "setup";
  if (lane.status === "error") return "blocked";
  if (laneThreads.some((t) => t.status === "awaiting_approval" || t.status === "error")) return "blocked";
  if (laneThreads.some((t) => t.status === "running" || t.status === "stopping")) return "working";
  return "idle";
}

export function SessionBoard({
  lanes,
  projects,
  threads,
  busy,
  onCreate,
  onArchive,
  onDiff,
  onOpenPr,
  onOpenThread,
  onNewThread,
}: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [needsCommit, setNeedsCommit] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [prResult, setPrResult] = useState<{ laneId: string; result: PrResult } | null>(null);
  const [prBusy, setPrBusy] = useState<string | null>(null);

  const active = useMemo(() => lanes.filter((l) => l.status !== "archived"), [lanes]);

  const grouped = useMemo(() => {
    const map: Record<Column, { lane: LaneView; laneThreads: ThreadView[] }[]> = {
      blocked: [],
      working: [],
      idle: [],
      setup: [],
    };
    for (const lane of active) {
      const laneThreads = threads.filter((t) => t.laneId === lane.id);
      map[columnFor(lane, laneThreads)].push({ lane, laneThreads });
    }
    return map;
  }, [active, threads]);

  const create = async () => {
    if (!projectId) return;
    setError(null);
    try {
      await onCreate(projectId, title.trim() || "New lane");
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openPr = async (lane: LaneView, message?: string) => {
    setError(null);
    setPrBusy(lane.id);
    try {
      const result = await onOpenPr(lane.id, lane.title, message);
      if (result.status === "needs_commit") {
        setNeedsCommit(lane.id);
      } else {
        setNeedsCommit(null);
        setCommitMessage("");
        setPrResult({ laneId: lane.id, result });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrBusy(null);
    }
  };

  const archive = async (lane: LaneView, force: boolean) => {
    setError(null);
    try {
      await onArchive(lane.id, true, force);
      setConfirming(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("uncommitted")) setConfirming(lane.id);
      else setError(message);
    }
  };

  return (
    <div className="board">
      <div className="board-head">
        <div className="board-create">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            placeholder="What is this lane for?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void create()}
          />
          <button className="btn" disabled={busy || !projectId} onClick={() => void create()}>
            New lane
          </button>
        </div>
        {error && <span className="hint danger">{error}</span>}
      </div>

      {active.length === 0 ? (
        <div className="empty">
          <h1>Run agents in parallel</h1>
          <p>
            Each lane gets its own git worktree and branch, so several agents can work on this repository at
            once without touching each other&rsquo;s files.
          </p>
        </div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map(({ key, label, hint }) => (
            <section key={key} className="board-column">
              <header>
                <span className="board-column-title">{label}</span>
                <span className="board-count">{grouped[key].length}</span>
              </header>
              {grouped[key].length === 0 ? (
                <span className="board-empty">{hint}</span>
              ) : (
                grouped[key].map(({ lane, laneThreads }) => (
                  <article key={lane.id} className="lane-card">
                    <div className="lane-card-head">
                      <span className="label">{lane.title}</span>
                      <span className="meta">:{lane.port}</span>
                    </div>
                    <code className="lane-branch">{lane.branch}</code>

                    {lane.status === "error" && lane.detail && (
                      <span className="hint danger">{lane.detail}</span>
                    )}

                    {laneThreads.length === 0 ? (
                      <button className="linkish" onClick={() => onNewThread(lane.id)}>
                        Start a thread here
                      </button>
                    ) : (
                      <div className="lane-threads">
                        {laneThreads.map((t) => (
                          <button key={t.id} className="lane-thread" onClick={() => onOpenThread(t.id)}>
                            <span className={`dot ${t.status}`} />
                            <span className="label">{t.title}</span>
                            <span className="meta">{t.status}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {needsCommit === lane.id && (
                      <div className="lane-commit">
                        <input
                          autoFocus
                          placeholder="Commit message"
                          value={commitMessage}
                          onChange={(e) => setCommitMessage(e.target.value)}
                          onKeyDown={(e) =>
                            e.key === "Enter" && commitMessage.trim() && void openPr(lane, commitMessage)
                          }
                        />
                        <button
                          className="btn"
                          disabled={!commitMessage.trim() || prBusy === lane.id}
                          onClick={() => void openPr(lane, commitMessage)}
                        >
                          Commit &amp; PR
                        </button>
                      </div>
                    )}

                    {prResult?.laneId === lane.id && (
                      <span className={`hint${prResult.result.status === "error" ? " danger" : ""}`}>
                        {prResult.result.url ? (
                          <a href={prResult.result.url} target="_blank" rel="noreferrer">
                            Pull request opened
                          </a>
                        ) : prResult.result.compareUrl ? (
                          <a href={prResult.result.compareUrl} target="_blank" rel="noreferrer">
                            Pushed — finish on the compare page
                          </a>
                        ) : (
                          prResult.result.detail
                        )}
                      </span>
                    )}

                    <div className="lane-card-actions">
                      <button className="icon" disabled={lane.status !== "ready"} onClick={() => onDiff(lane.id)}>
                        Diff
                      </button>
                      <button
                        className="icon"
                        disabled={lane.status !== "ready" || prBusy === lane.id}
                        onClick={() => void openPr(lane)}
                      >
                        {prBusy === lane.id ? "Opening…" : "PR"}
                      </button>
                      {confirming === lane.id ? (
                        <>
                          <button className="btn danger" onClick={() => void archive(lane, true)}>
                            Discard &amp; archive
                          </button>
                          <button className="icon" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="icon" onClick={() => void archive(lane, false)}>
                          Archive
                        </button>
                      )}
                    </div>
                    {confirming === lane.id && (
                      <span className="hint danger">Uncommitted work in this lane will be lost.</span>
                    )}
                  </article>
                ))
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
