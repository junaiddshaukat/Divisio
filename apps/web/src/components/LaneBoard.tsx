import { useState } from "react";
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
  onClose(): void;
}

const STATUS_LABEL: Record<LaneView["status"], string> = {
  preparing: "preparing",
  ready: "ready",
  error: "error",
  archived: "archived",
};

/** Maps lane status onto the shared status dot colours. */
const STATUS_DOT: Record<LaneView["status"], string> = {
  preparing: "running",
  ready: "ready",
  error: "error",
  archived: "",
};

export function LaneBoard({ lanes, projects, threads, busy, onCreate, onArchive, onDiff, onOpenPr, onClose }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Lane awaiting a commit message before its PR can be opened. */
  const [needsCommit, setNeedsCommit] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [prResult, setPrResult] = useState<{ laneId: string; result: PrResult } | null>(null);
  const [prBusy, setPrBusy] = useState<string | null>(null);

  const openPr = async (lane: LaneView, message?: string) => {
    setError(null);
    setPrBusy(lane.id);
    try {
      const result = await onOpenPr(lane.id, lane.title, message);
      if (result.status === "needs_commit") {
        // Not a failure — the lane simply has work that is not recorded yet.
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

  const active = lanes.filter((l) => l.status !== "archived");

  const create = async () => {
    setError(null);
    try {
      await onCreate(projectId, title.trim() || "New lane");
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const archive = async (lane: LaneView, force: boolean) => {
    setError(null);
    try {
      await onArchive(lane.id, true, force);
      setConfirming(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The daemon refuses to discard uncommitted work without confirmation.
      // Surface that as a decision rather than as a failure.
      if (message.includes("uncommitted")) setConfirming(lane.id);
      else setError(message);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog lane-board" onClick={(e) => e.stopPropagation()}>
        <h2>Parallel lanes</h2>
        <span className="hint">
          Each lane is its own git worktree and branch, so agents never edit the same files.
        </span>

        <div className="lane-create">
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
            onKeyDown={(e) => e.key === "Enter" && !busy && projectId && void create()}
          />
          <button className="btn" disabled={busy || !projectId} onClick={() => void create()}>
            Create
          </button>
        </div>

        {error && <span className="hint danger">{error}</span>}

        {active.length === 0 && <span className="hint">No lanes yet.</span>}

        <div className="lane-list">
          {active.map((lane) => {
            const bound = threads.filter((t) => t.laneId === lane.id);
            return (
              <div key={lane.id} className="lane-row">
                <div className="lane-main">
                  <div className="lane-title">
                    <span className={`dot ${STATUS_DOT[lane.status]}`} />
                    <span className="label">{lane.title}</span>
                    <span className="pill">{STATUS_LABEL[lane.status]}</span>
                  </div>
                  <div className="lane-meta">
                    <code>{lane.branch}</code>
                    <span>port {lane.port}</span>
                    <span>
                      {bound.length} thread{bound.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {lane.status === "preparing" && (
                    <span className="hint">
                      Installing dependencies — a fresh worktree has none until setup runs.
                    </span>
                  )}
                  {lane.status === "error" && lane.detail && <span className="hint danger">{lane.detail}</span>}

                  {needsCommit === lane.id && (
                    <div className="lane-commit">
                      <input
                        autoFocus
                        placeholder="Commit message for this lane's work"
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
                        Commit &amp; open PR
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
                          Pushed — open the compare page to finish
                        </a>
                      ) : (
                        prResult.result.detail
                      )}
                      {prResult.result.url && prResult.result.detail ? ` · ${prResult.result.detail}` : ""}
                    </span>
                  )}
                </div>

                <div className="lane-actions">
                  <button className="icon" onClick={() => onDiff(lane.id)} disabled={lane.status !== "ready"}>
                    Diff
                  </button>
                  <button
                    className="icon"
                    disabled={lane.status !== "ready" || prBusy === lane.id}
                    onClick={() => void openPr(lane)}
                  >
                    {prBusy === lane.id ? "Opening…" : "Open PR"}
                  </button>
                  {confirming === lane.id ? (
                    <>
                      <span className="hint danger">Uncommitted work will be lost.</span>
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
              </div>
            );
          })}
        </div>

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
