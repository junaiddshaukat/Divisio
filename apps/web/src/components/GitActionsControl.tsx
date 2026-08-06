import { useEffect, useState } from "react";
import { Button } from "./ui/Button.tsx";
import { ChevronDownIcon, CommitIcon } from "./ui/icons.ts";

export type GitPrimary = "commit" | "commit_push" | "push" | "create_pr";

interface Props {
  dirty: boolean;
  hasRemote: boolean;
  /** Lane-bound threads can open a PR via lane.openPr. */
  canPr: boolean;
  busy?: boolean;
  onCommit(message: string): Promise<{ ok: boolean; detail?: string }>;
  onPush(): Promise<{ ok: boolean; detail?: string; compareUrl?: string | null }>;
  onOpenPr?(title: string, commitMessage?: string): Promise<{
    status: string;
    url: string | null;
    compareUrl: string | null;
    detail: string | null;
  }>;
}

/**
 * Header git chrome. Diff stays in Changes; ship actions live here.
 */
export function GitActionsControl({
  dirty,
  hasRemote,
  canPr,
  busy,
  onCommit,
  onPush,
  onOpenPr,
}: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<"commit" | "commit_push" | "pr" | null>(null);

  const primary: GitPrimary = dirty
    ? hasRemote
      ? "commit_push"
      : "commit"
    : canPr
      ? "create_pr"
      : hasRemote
        ? "push"
        : "commit";

  const primaryLabel =
    primary === "commit_push"
      ? "Commit & push"
      : primary === "create_pr"
        ? "Create PR"
        : primary === "push"
          ? "Push"
          : "Commit";

  useEffect(() => {
    if (!open) {
      setMessage("");
      setPending(null);
    }
  }, [open]);

  const runCommit = async (alsoPush: boolean) => {
    const msg = message.trim();
    if (!msg) return;
    setWorking(true);
    setHint(null);
    try {
      const committed = await onCommit(msg);
      if (!committed.ok) {
        setHint(committed.detail ?? "Commit failed");
        return;
      }
      if (alsoPush) {
        const pushed = await onPush();
        if (!pushed.ok) {
          setHint(pushed.detail ?? "Pushed failed after commit");
          return;
        }
        setHint(pushed.compareUrl ? "Committed and pushed." : "Committed and pushed.");
      } else {
        setHint("Committed.");
      }
      setOpen(false);
      setMessage("");
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const runPush = async () => {
    setWorking(true);
    setHint(null);
    try {
      const res = await onPush();
      setHint(res.ok ? (res.compareUrl ? "Pushed." : "Pushed.") : (res.detail ?? "Push failed"));
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const runPr = async () => {
    if (!onOpenPr) return;
    if (dirty) {
      setPending("pr");
      setOpen(true);
      return;
    }
    setWorking(true);
    setHint(null);
    try {
      const res = await onOpenPr("Pull request from Divisio");
      if (res.status === "needs_commit") {
        setPending("pr");
        setOpen(true);
        setHint(res.detail ?? "Commit before opening a PR");
        return;
      }
      if (res.status === "error") {
        setHint(res.detail ?? "PR failed");
        return;
      }
      setHint(res.url ? "Pull request opened." : res.compareUrl ? "Pushed — finish on GitHub." : "Done.");
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const primaryClick = () => {
    if (primary === "commit" || primary === "commit_push") {
      setPending(primary === "commit_push" ? "commit_push" : "commit");
      setOpen(true);
      return;
    }
    if (primary === "push") void runPush();
    if (primary === "create_pr") void runPr();
  };

  const disabled = !!busy || working;

  return (
    <div className="git-actions">
      <Button
        variant="secondary"
        size="sm"
        icon={<CommitIcon />}
        loading={working}
        disabled={disabled || (primary === "commit" && !dirty && !open)}
        onClick={primaryClick}
      >
        {primaryLabel}
      </Button>
      <details className="git-menu">
        <summary className="git-menu-trigger" aria-label="More git actions">
          <ChevronDownIcon />
        </summary>
        <div className="git-menu-panel">
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => {
              setPending("commit");
              setOpen(true);
            }}
          >
            Commit…
          </button>
          <button
            type="button"
            disabled={disabled || !dirty || !hasRemote}
            onClick={() => {
              setPending("commit_push");
              setOpen(true);
            }}
          >
            Commit &amp; push…
          </button>
          <button type="button" disabled={disabled || dirty || !hasRemote} onClick={() => void runPush()}>
            Push
          </button>
          {canPr && onOpenPr && (
            <button type="button" disabled={disabled} onClick={() => void runPr()}>
              Create PR…
            </button>
          )}
        </div>
      </details>

      {open && (
        <div className="git-commit-popover">
          <input
            autoFocus
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && message.trim()) {
                if (pending === "pr") {
                  void (async () => {
                    if (!onOpenPr) return;
                    setWorking(true);
                    try {
                      const res = await onOpenPr("Pull request from Divisio", message.trim());
                      setHint(
                        res.status === "error"
                          ? (res.detail ?? "PR failed")
                          : res.url
                            ? "Pull request opened."
                            : "Done.",
                      );
                      if (res.status !== "error" && res.status !== "needs_commit") setOpen(false);
                    } catch (err) {
                      setHint(err instanceof Error ? err.message : String(err));
                    } finally {
                      setWorking(false);
                    }
                  })();
                } else {
                  void runCommit(pending === "commit_push");
                }
              }
              if (e.key === "Escape") setOpen(false);
            }}
            disabled={working}
          />
          <div className="actions">
            <Button
              variant="primary"
              size="sm"
              disabled={!message.trim() || working}
              onClick={() => {
                if (pending === "pr") {
                  void (async () => {
                    if (!onOpenPr) return;
                    setWorking(true);
                    try {
                      const res = await onOpenPr("Pull request from Divisio", message.trim());
                      setHint(
                        res.status === "error"
                          ? (res.detail ?? "PR failed")
                          : res.url
                            ? "Pull request opened."
                            : "Done.",
                      );
                      if (res.status !== "error" && res.status !== "needs_commit") setOpen(false);
                    } catch (err) {
                      setHint(err instanceof Error ? err.message : String(err));
                    } finally {
                      setWorking(false);
                    }
                  })();
                } else {
                  void runCommit(pending === "commit_push");
                }
              }}
            >
              {pending === "pr" ? "Commit & PR" : pending === "commit_push" ? "Commit & push" : "Commit"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {hint && <span className="git-hint">{hint}</span>}
    </div>
  );
}
