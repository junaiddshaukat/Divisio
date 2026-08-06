import type { ProviderView } from "@divisio/contracts";
import { CheckIcon } from "../ui/icons.ts";
import { ProviderMark } from "../ProviderMark.tsx";

const FLAGS = [
  "sessionResume",
  "interruptTurn",
  "approvals",
  "worktreeAware",
  "usageSignals",
  "modelSwitch",
  "handoffExport",
] as const;

const FLAG_LABEL: Record<(typeof FLAGS)[number], string> = {
  sessionResume: "Resume",
  interruptTurn: "Interrupt",
  approvals: "Approvals",
  worktreeAware: "Worktrees",
  usageSignals: "Usage",
  modelSwitch: "Models",
  handoffExport: "Handoff",
};

interface Props {
  providers: ProviderView[];
  onRefresh(): void;
}

/** Provider status rows for Settings — honest availability + compact capability chips. */
export function ProvidersSettings({ providers }: Props) {
  return (
    <div className="settings-section">
      <div className="settings-rows">
        {providers.map((p) => (
          <div key={p.kind} className="settings-row settings-row-stack">
            <div className="settings-row-main">
              <ProviderMark kind={p.kind} />
              <div className="settings-row-copy">
                <span className="settings-row-label">{p.label}</span>
                {(p.version || p.source === "community" || (!p.available && p.detail)) && (
                  <span className="settings-row-meta">
                    {[
                      p.source === "community" ? "community" : null,
                      p.available ? p.version : null,
                      !p.available ? p.detail : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </div>
              {p.available ? (
                <span className="settings-status ok">ready</span>
              ) : (
                <span className="settings-status warn" title={p.detail ?? undefined}>
                  unavailable
                </span>
              )}
            </div>
            <div className="settings-cap-chips" aria-label={`${p.label} capabilities`}>
              {FLAGS.map((f) => (
                <span
                  key={f}
                  className={`settings-cap-chip${p.capabilities[f] ? " is-on" : ""}`}
                  title={f}
                >
                  {p.capabilities[f] ? <CheckIcon className="lucide" /> : null}
                  {FLAG_LABEL[f]}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
