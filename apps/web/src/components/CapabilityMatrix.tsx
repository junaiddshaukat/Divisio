import type { ProviderView } from "@divisio/contracts";

const FLAGS = [
  "sessionResume",
  "interruptTurn",
  "approvals",
  "worktreeAware",
  "usageSignals",
  "modelSwitch",
  "handoffExport",
] as const;

interface Props {
  providers: ProviderView[];
  onClose(): void;
  onRefresh(): void;
}

/** Declared adapter capabilities — the UI trusts this matrix, never guesses. */
export function CapabilityMatrix({ providers, onClose, onRefresh }: Props) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog matrix-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Providers</h2>
        <p className="muted">
          Divisio drives CLIs already on this machine. Flags are honest: unsupported means unsupported.
        </p>
        <div className="matrix-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                {FLAGS.map((f) => (
                  <th key={f}>{f}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.kind}>
                  <td>
                    <strong>{p.label}</strong>
                    <div className="meta">{p.tier}{p.version ? ` · ${p.version}` : ""}</div>
                  </td>
                  <td>
                    {p.available ? (
                      <span className="pill ok">ready</span>
                    ) : (
                      <span className="pill warn" title={p.detail ?? undefined}>
                        unavailable
                      </span>
                    )}
                    {!p.available && p.detail && <div className="meta">{p.detail}</div>}
                  </td>
                  {FLAGS.map((f) => (
                    <td key={f} className="flag">
                      {p.capabilities[f] ? "✓" : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button className="btn secondary" onClick={onRefresh}>
            Refresh
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
