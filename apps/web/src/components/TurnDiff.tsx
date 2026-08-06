import { useState } from "react";
import type { DiffFileEntry } from "@divisio/contracts";

interface Props {
  turnId: string;
  /** Absent for lane diffs, which have no single turn to restore to. */
  onRestore?(turnId: string): Promise<void>;
  files: DiffFileEntry[];
  patch: string | null;
  status: string;
  detail?: string;
  onClose(): void;
}

export function TurnDiff({ turnId, files, patch, status, detail, onRestore, onClose }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    if (!onRestore) return;
    setBusy(true);
    try {
      await onRestore(turnId);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog diff-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Turn diff</h2>
        <p className="muted">
          Changes since the pre-turn checkpoint · <code>{turnId}</code>
        </p>
        {status !== "ready" && (
          <div className="banner">{detail ?? status}</div>
        )}
        {files.length === 0 && status === "ready" && (
          <p className="muted">No file changes.</p>
        )}
        {files.length > 0 && (
          <ul className="diff-files">
            {files.map((f) => (
              <li key={f.path}>
                <span className="pill">{f.status}</span> {f.path}
              </li>
            ))}
          </ul>
        )}
        {patch && (
          <pre className="diff-patch">
            <code>{patch}</code>
          </pre>
        )}
        <div className="actions">
          {onRestore && status === "ready" && (
            confirming ? (
              <>
                {/*
                  Restoring overwrites the working tree. The daemon captures the
                  current state first, so this is recoverable — but it still
                  asks, because a surprise overwrite is never acceptable.
                */}
                <span className="hint danger">
                  Overwrite the working tree with the state before this turn?
                </span>
                <button className="btn danger" disabled={busy} onClick={() => void restore()}>
                  {busy ? "Restoring…" : "Restore"}
                </button>
                <button className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn ghost" onClick={() => setConfirming(true)}>
                Restore this turn
              </button>
            )
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
