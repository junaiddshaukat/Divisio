import { useState } from "react";
import type { PermissionMode, ProviderView } from "@divisio/contracts";
import { PermissionModeSelect } from "./ApprovalBar.tsx";

interface Props {
  busy: boolean;
  provider: string;
  providers: ProviderView[];
  permissionMode: PermissionMode;
  onSend(text: string): void;
  onInterrupt(): void;
  onPermissionMode(mode: PermissionMode): void;
}

export function Composer({
  busy,
  provider,
  providers,
  permissionMode,
  onSend,
  onInterrupt,
  onPermissionMode,
}: Props) {
  const [text, setText] = useState("");
  const info = providers.find((p) => p.kind === provider);
  const canMediate = !!info?.capabilities["approvals"];

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    onSend(value);
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          value={text}
          rows={1}
          placeholder={busy ? "Running…" : "Ask for follow-up…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <span className="pill">{info?.label ?? provider}</span>
          <PermissionModeSelect
            mode={permissionMode}
            canMediate={canMediate}
            onChange={onPermissionMode}
          />
          {busy ? (
            <button className="btn danger" onClick={onInterrupt}>
              Stop
            </button>
          ) : (
            <button className="btn" disabled={!text.trim()} onClick={submit}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
