import { useState } from "react";
import type { ProviderView } from "@divisio/contracts";

interface Props {
  current: string;
  providers: ProviderView[];
  busy: boolean;
  onHandoff(toProvider: string): void;
}

/**
 * Moving a thread to another provider.
 *
 * The cost is stated up front: the source agent writes the handover note, so a
 * handoff spends one turn on the provider you are leaving. Hiding that would
 * make the token usage look unexplained.
 */
export function HandoffMenu({ current, providers, busy, onHandoff }: Props) {
  const [open, setOpen] = useState(false);
  const targets = providers.filter((p) => p.available && p.kind !== current);

  if (targets.length === 0) return null;

  return (
    <span className="handoff">
      <button className="icon" disabled={busy} onClick={() => setOpen((v) => !v)}>
        {busy ? "Handing off…" : "Hand off"}
      </button>
      {open && (
        <div className="handoff-menu">
          <span className="hint">
            The current agent writes a handover note first, which costs one turn on {current}.
          </span>
          {targets.map((p) => (
            <button
              key={p.kind}
              className="row"
              onClick={() => {
                setOpen(false);
                onHandoff(p.kind);
              }}
            >
              <span className="label">{p.label}</span>
              <span className="meta">{p.tier}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
