import { useEffect, useRef, useState } from "react";
import type { ProviderView } from "@divisio/contracts";
import { Button } from "./ui/Button.tsx";
import { HandoffIcon } from "./ui/icons.ts";
import { ProviderMark } from "./ProviderMark.tsx";

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
  const rootRef = useRef<HTMLSpanElement>(null);
  const targets = providers.filter((p) => p.available && p.kind !== current);
  const currentLabel = providers.find((p) => p.kind === current)?.label ?? current;

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
        loading={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        Hand off
      </Button>
      {open && (
        <div className="handoff-menu" role="menu" aria-label="Hand off to another agent">
          <div className="handoff-menu-copy">
            <strong>Continue on another agent</strong>
            <p>
              {currentLabel} writes a short handover note first (costs one turn), then the
              chosen agent picks up this thread with that context.
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
              <ProviderMark kind={p.kind} />
              <span className="handoff-row-text">
                <span className="handoff-row-label">{p.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
