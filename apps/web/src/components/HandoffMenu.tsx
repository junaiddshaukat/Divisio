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
  /** Handoff RPC in flight. */
  handoffBusy: boolean;
  /**
   * Skip asking the current CLI for a note — used when it has hit a usage
   * limit and cannot take a turn.
   */
  logOnly?: boolean;
  /** Icon-only when the topbar is in compact chrome mode. */
  compact?: boolean;
  onHandoff(toProvider: string): void;
}

/**
 * Moving a chat to another provider.
 *
 * When the current CLI can still talk, it may write a handover note (one turn).
 * If it is rate-limited, Divisio seeds the next agent from the saved transcript.
 */
export function HandoffMenu({
  current,
  providers,
  turnBusy,
  handoffBusy,
  logOnly = false,
  compact,
  onHandoff,
}: Props) {
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
    <span className={logOnly ? "handoff handoff-inline" : "handoff"} ref={rootRef}>
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
              ? "Handing off…"
              : logOnly
                ? "Continue on another agent from the saved transcript"
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
              {logOnly
                ? `${currentLabel} hit a usage limit, so Divisio will seed the next agent from this transcript — no extra turn on the limited CLI.`
                : `If ${currentLabel} can still talk, it writes a short note first. If it is rate-limited, Divisio hands off from the saved transcript instead.`}
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
