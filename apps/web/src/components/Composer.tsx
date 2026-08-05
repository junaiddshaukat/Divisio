import { useState } from "react";
import type { ProviderView } from "@divisio/contracts";

interface Props {
  busy: boolean;
  provider: string;
  providers: ProviderView[];
  onSend(text: string): void;
  onInterrupt(): void;
}

export function Composer({ busy, provider, providers, onSend, onInterrupt }: Props) {
  const [text, setText] = useState("");
  const info = providers.find((p) => p.kind === provider);

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
            // Enter sends, Shift+Enter newlines. No animation on this path.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <span className="pill">{info?.label ?? provider}</span>
          {/*
            Capability honesty: this adapter cannot mediate approvals, so the UI
            says the CLI is enforcing its own permissions rather than showing an
            approve/deny control that would not be wired to anything.
          */}
          <span className={`pill${info && !info.capabilities["approvals"] ? " warn" : ""}`}>
            {info && !info.capabilities["approvals"] ? "CLI-managed permissions" : "supervised"}
          </span>
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
