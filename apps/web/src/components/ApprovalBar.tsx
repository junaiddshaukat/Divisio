import type { PermissionMode } from "@divisio/contracts";

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
        <button className="btn danger" onClick={() => onRespond("deny")}>
          Deny
        </button>
        <button className="btn" onClick={() => onRespond("approve")}>
          Approve
        </button>
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
    return <span className="pill warn">CLI-managed permissions</span>;
  }
  return (
    <select
      className="mode-select"
      value={mode}
      title={mode === "full_access" ? "Higher risk: mutating tools auto-approve" : "Approve mutating tools"}
      onChange={(e) => onChange(e.target.value as PermissionMode)}
    >
      <option value="supervised">supervised</option>
      <option value="full_access">full access</option>
    </select>
  );
}
