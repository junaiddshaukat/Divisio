import { PRODUCT_NAME } from "@divisio/shared/brand";
import type { ConnectionState } from "../../client.ts";
import { Button } from "../ui/Button.tsx";

interface Props {
  connectionState: ConnectionState;
  /** Clear first-run dismissal and show the welcome flow again. */
  onReplayWelcome?(): void;
}

function connectionLabel(state: ConnectionState): string {
  if (state === "open") return "Connected to daemon";
  if (state === "connecting") return "Connecting…";
  return `Daemon ${state}`;
}

/** Product about + environment facts — no fake toggles. */
export function GeneralSettings({ connectionState, onReplayWelcome }: Props) {
  const vibrancy = document.documentElement.classList.contains("desktop-vibrancy");

  return (
    <div className="settings-section">
      <div className="settings-group">
        <h4 className="settings-group-title">About</h4>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">{PRODUCT_NAME}</span>
              <span className="settings-row-meta">Local-first multi-agent command center</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">Daemon</span>
              <span className="settings-row-meta">{connectionLabel(connectionState)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">Window</h4>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">System materials</span>
              <span className="settings-row-meta">
                {vibrancy
                  ? "Desktop window uses native vibrancy under the chrome"
                  : "Browser session — solid surfaces only"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {onReplayWelcome && (
        <div className="settings-group">
          <h4 className="settings-group-title">First run</h4>
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-copy">
                <span className="settings-row-label">Welcome checklist</span>
                <span className="settings-row-meta">
                  Providers, project folder, and a first prompt — skippable any time
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={onReplayWelcome}>
                Show again
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
