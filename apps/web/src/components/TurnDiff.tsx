import type { DiffFileEntry } from "@divisio/contracts";

interface Props {
  turnId: string;
  files: DiffFileEntry[];
  patch: string | null;
  status: string;
  detail?: string;
  onClose(): void;
}

export function TurnDiff({ turnId, files, patch, status, detail, onClose }: Props) {
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
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
