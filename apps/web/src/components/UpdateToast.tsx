import { useState } from "react";
import type { ProviderUpdate } from "@divisio/contracts";
import { Button, IconButton } from "./ui/Button.tsx";
import { CloseIcon, WarningIcon } from "./ui/icons.ts";

const DISMISS_KEY = "divisio:cli-update-dismissed";

function dismissId(update: ProviderUpdate): string {
  return `${update.kind}@${update.latest}`;
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(ids: Set<string>): void {
  localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids]));
}

/**
 * Bottom-left notice when a detected CLI is behind npm latest.
 * Divisio never runs the upgrade — Review opens Settings, Update all copies commands.
 */
export function UpdateToast({
  updates,
  onReview,
}: {
  updates: ProviderUpdate[];
  onReview(): void;
}) {
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [copied, setCopied] = useState(false);
  const visible = updates.filter((u) => !dismissed.has(dismissId(u)));
  if (visible.length === 0) return null;

  const primary = visible[0]!;
  const title =
    visible.length === 1 ? `${primary.label} update available` : "CLI updates available";
  const body =
    visible.length === 1
      ? `${primary.label} has a newer version available.`
      : `${visible.length} agents have newer versions.`;

  const dismiss = () => {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const u of visible) next.add(dismissId(u));
      persistDismissed(next);
      return next;
    });
  };

  const copyAll = async () => {
    const text = visible.map((u) => u.command).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard can be denied; the commands still live in Settings */
    }
  };

  return (
    <div className="update-toast-stack" role="status" aria-live="polite">
      <div className="update-toast">
        <div className="update-toast-head">
          <WarningIcon />
          <p className="update-toast-title">{title}</p>
          <IconButton label="Dismiss" icon={<CloseIcon />} size="sm" onClick={dismiss} />
        </div>
        <p className="update-toast-body">{body}</p>
        <div className="update-toast-actions">
          <Button variant="secondary" size="sm" onClick={onReview}>
            Review updates
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copyAll()}>
            {copied ? "Copied" : "Update all"}
          </Button>
        </div>
      </div>
    </div>
  );
}
