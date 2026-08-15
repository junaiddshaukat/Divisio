import { useEffect, useRef, useState } from "react";
import type { ProviderView } from "@divisio/contracts";
import { displayLabel, isProviderEnabled, loadProviderPrefs } from "../providerPrefs.ts";
import { Button } from "./ui/Button.tsx";
import { HandoffIcon } from "./ui/icons.ts";
import { ProviderMark } from "./ProviderMark.tsx";

interface Props {
  current: string;
  providers: ProviderView[];
  /** A turn is running — handoff needs a free source turn. */
  turnBusy: boolean;
  /** Handoff RPC in flight (source agent writing the note). */
  handoffBusy: boolean;
  /** Icon-only when the topbar is in compact chrome mode. */
  compact?: boolean;
  onHandoff(toProvider: string): void;
}

/**
 * Moving a chat to another provider.
 *
 * The cost is stated up front: the source agent writes the handover note, so a
 * handoff spends one turn on the provider you are leaving.
 */
export function HandoffMenu({ current, providers, turnBusy, handoffBusy, compact, onHandoff }: Props) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(loadProviderPrefs);
  const rootRef = useRef<HTMLSpanElement>(null);
  const targets = providers.filter(
    (p) => p.available && p.kind !== current && isProviderEnabled(p.kind, prefs),
  );
  const currentLabel = displayLabel(
    current,
    providers.find((p) => p.kind === current)?.label ?? current,
    prefs,
  );
  const blocked = turnBusy || handoffBusy;

  useEffect(() => {
    const sync = () => setPrefs(loadProviderPrefs());
    window.addEventListener("divisio:provider-prefs", sync);
    return () => window.removeEventListener("divisio:provider-prefs", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (targets.length === 0) return null;

  return (
    <span className="handoff" ref={rootRef}>
      <Button
        variant="ghost"
        size="sm"
        icon={<HandoffIcon />}
        loading={handoffBusy}
        disabled={blocked}
        title={
          turnBusy
            ? "Stop the running turn before handing off"
            : handoffBusy
              ? "Source agent is writing the handover note…"
              : "Continue this chat on another agent"
        }
        aria-label={handoffBusy ? "Handing off…" : "Hand off"}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => !blocked && setOpen((v) => !v)}
      >
        {!compact && (
          <span className="topbar-action-label">{handoffBusy ? "Handing off…" : "Hand off"}</span>
        )}
      </Button>
      {open && !blocked && (
        <div className="handoff-menu" role="menu" aria-label="Hand off to another agent">
          <div className="handoff-menu-copy">
            <strong>Continue on another agent</strong>
            <p>
              {currentLabel} writes a short handover note first (costs one turn), then the
              chosen agent picks up this chat with that context.
            </p>
          </div>
          {targets.map((p) => (
            <button
              key={p.kind}
              type="button"
              className="handoff-row"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onHandoff(p.kind);
              }}
            >
              <ProviderMark kind={p.kind} accent={prefs[p.kind]?.accent} />
              <span className="handoff-row-text">
                <span className="handoff-row-label">{displayLabel(p.kind, p.label, prefs)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
