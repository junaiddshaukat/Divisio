const BINDINGS: { action: string; keys: string[] }[] = [
  { action: "Command palette", keys: ["⌘K", "Ctrl+K"] },
  { action: "Reload window (UI only)", keys: ["⌘R", "Ctrl+R"] },
  { action: "Close settings / dialogs", keys: ["Escape"] },
];

/** Read-only shortcut list — remapping is not in this build. */
export function KeybindingsSettings() {
  return (
    <div className="settings-section">
      <div className="settings-group">
        <h4 className="settings-group-title">Shortcuts</h4>
        <div className="settings-rows">
          {BINDINGS.map((b) => (
            <div key={b.action} className="settings-row">
              <div className="settings-row-copy">
                <span className="settings-row-label">{b.action}</span>
              </div>
              <span className="settings-keys">
                {b.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="settings-section-desc">
        A keybinding remapper is not in this build. Shortcuts above are fixed.
        Reload window refreshes the UI and reconnects; it does not restart the
        daemon.
      </p>
    </div>
  );
}
