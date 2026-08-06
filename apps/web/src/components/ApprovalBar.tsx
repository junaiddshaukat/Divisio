import type { PermissionMode } from "@divisio/contracts";
import { Button } from "./ui/Button.tsx";
import { LockIcon } from "./ui/icons.ts";

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

/** Approve/deny bar for providers that mediate permissions (e.g. Codex). */
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
  canMediate: boolean;
  onChange(mode: PermissionMode): void;
}

export function PermissionModeSelect({ mode, canMediate, onChange }: ModeProps) {
  if (!canMediate) {
    return (
      <span className="perm-pill" title="This agent’s CLI manages its own tool approvals">
        <LockIcon />
        CLI managed
      </span>
    );
  }
  return (
    <select
      className={`perm-select${mode === "full_access" ? " elevated" : ""}`}
      value={mode}
      title={mode === "full_access" ? "Higher risk: mutating tools auto-approve" : "Approve mutating tools"}
      onChange={(e) => onChange(e.target.value as PermissionMode)}
    >
      <option value="supervised">Supervised</option>
      <option value="full_access">Full access</option>
    </select>
  );
}
