import { useEffect, useId, useRef, useState } from "react";
import type { PermissionMode } from "@divisio/contracts";
import { Button } from "./ui/Button.tsx";
import { ChevronDownIcon, LockIcon, UnlockIcon } from "./ui/icons.ts";

export interface PendingApproval {
  approvalId: string;
  turnId: string;
  category: string;
  summary: string;
}

interface Props {
  pending: PendingApproval;
  onRespond(decision: "approve" | "deny"): void;
}

/** Approve/deny bar for providers that surface tool asks through Divisio. */
export function ApprovalBar({ pending, onRespond }: Props) {
  return (
    <div className="approval-bar" role="alertdialog" aria-label="Permission request">
      <div className="approval-body">
        <span className="pill warn">{pending.category}</span>
        <span className="approval-summary">{pending.summary}</span>
      </div>
      <div className="actions">
        <Button variant="danger" size="sm" onClick={() => onRespond("deny")}>
          Deny
        </Button>
        <Button variant="primary" size="sm" onClick={() => onRespond("approve")}>
          Approve
        </Button>
      </div>
    </div>
  );
}

interface ModeProps {
  mode: PermissionMode;
  /** True only when this adapter emits Approve/Deny into Divisio (Codex today). */
  mediated?: boolean;
  onChange(mode: PermissionMode): void;
}

/**
 * How freely the agent may act in this chat.
 * Adapters map these to CLI flags (or Divisio approval prompts when supported).
 * Copy must not claim Divisio will pause tools unless the adapter mediates.
 */
function modeCopy(mediated: boolean): {
  id: PermissionMode;
  label: string;
  detail: string;
  Icon: typeof LockIcon;
}[] {
  return [
    {
      id: "supervised",
      label: "Confirm first",
      detail: mediated
        ? "Pause before tools and file writes so you stay in the loop"
        : "This CLI owns approvals. Divisio cannot Approve or Deny in the chat",
      Icon: LockIcon,
    },
    {
      id: "full_access",
      label: "Run freely",
      detail: mediated
        ? "Skip pauses — tools and edits keep going in this chat"
        : "Ask the CLI to skip its own confirms when it supports that",
      Icon: UnlockIcon,
    },
  ];
}

export function PermissionModeSelect({ mode, mediated = false, onChange }: ModeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const modes = modeCopy(mediated);
  const current = modes.find((m) => m.id === mode) ?? modes[0]!;

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

  const CurrentIcon = current.Icon;

  return (
    <div className="perm-menu" ref={rootRef}>
      <button
        type="button"
        className={`perm-trigger${mode === "full_access" ? " elevated" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title="How freely this agent may act"
        onClick={() => setOpen((v) => !v)}
      >
        <CurrentIcon />
        <span>{current.label}</span>
        <ChevronDownIcon className="perm-trigger-chevron" />
      </button>
      {open && (
        <ul className="perm-menu-panel" role="listbox" id={listId} aria-label="Agent freedom">
          {modes.map((m) => {
            const Icon = m.Icon;
            const selected = m.id === mode;
            return (
              <li key={m.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`perm-option${selected ? " selected" : ""}`}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <Icon />
                  <span className="perm-option-copy">
                    <span className="perm-option-label">{m.label}</span>
                    <span className="perm-option-detail">{m.detail}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
