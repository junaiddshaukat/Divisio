import { useCallback, useEffect, useState } from "react";
import type { ToolchainStatus } from "@divisio/contracts";

interface Props {
  load(): Promise<ToolchainStatus>;
}

function statusText(tool: ToolchainStatus["git"] | ToolchainStatus["gh"]): string {
  if (!tool.available) return tool.detail ?? "Not found";
  const parts: string[] = [];
  if (tool.version) parts.push(tool.version);
  if (tool.authenticated === false) parts.push(tool.detail ?? "Not authenticated");
  else if (tool.authenticated === true) parts.push(tool.detail ?? "Authenticated");
  else if (tool.detail) parts.push(tool.detail);
  return parts.join(" · ") || "Available";
}

function TogglePlaceholder({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      className={`settings-toggle${checked ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}
      role="presentation"
      aria-hidden
    />
  );
}

/** Version Control + host CLIs — live probes from the daemon. */
export function SourceControlSettings({ load }: Props) {
  const [status, setStatus] = useState<ToolchainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await load());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        message === "not connected" || message === "connection closed"
          ? "Disconnected from the local daemon. Click Retry in the sidebar."
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const git = status?.git;
  const gh = status?.gh;

  return (
    <div className="settings-section">
      {error && <p className="settings-inline-error">{error}</p>}

      <div className="settings-group">
        <h4 className="settings-group-title">Version Control</h4>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">Git</span>
              <span className="settings-row-meta">
                {loading && !git ? "Detecting…" : git ? statusText(git) : "—"}
              </span>
            </div>
            <TogglePlaceholder checked={!!git?.available} disabled />
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">Host CLIs</h4>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">GitHub CLI</span>
              <span className="settings-row-meta">
                {loading && !gh ? "Detecting…" : gh ? statusText(gh) : "—"}
              </span>
            </div>
            <TogglePlaceholder checked={!!gh?.available && gh.authenticated !== false} disabled />
          </div>
          <div className="settings-row is-muted">
            <div className="settings-row-copy">
              <span className="settings-row-label">GitLab</span>
              <span className="settings-row-meta">Not configured in this build</span>
            </div>
            <TogglePlaceholder checked={false} disabled />
          </div>
          <div className="settings-row is-muted">
            <div className="settings-row-copy">
              <span className="settings-row-label">Bitbucket</span>
              <span className="settings-row-meta">Not configured in this build</span>
            </div>
            <TogglePlaceholder checked={false} disabled />
          </div>
        </div>
      </div>
    </div>
  );
}
