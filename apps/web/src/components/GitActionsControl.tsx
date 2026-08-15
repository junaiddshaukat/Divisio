import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/Button.tsx";
import { ChevronDownIcon, CommitIcon } from "./ui/icons.ts";

export type GitPrimary = "commit" | "commit_push" | "push" | "create_pr";

interface Props {
  dirty: boolean;
  hasRemote: boolean;
  /** Lane-bound threads can open a PR via lane.openPr. */
  canPr: boolean;
  busy?: boolean;
  /** Icon-only when the topbar is in compact chrome mode. */
  compact?: boolean;
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
 * Menu + commit popover close on outside click / Escape.
 */
export function GitActionsControl({
  dirty,
  hasRemote,
  canPr,
  busy,
  compact,
  onCommit,
  onPush,
  onOpenPr,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<"commit" | "commit_push" | "pr" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen && !open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, open]);

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
          setHint(pushed.detail ?? "Push failed after commit");
          return;
        }
        setHint("Committed and pushed.");
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
    setMenuOpen(false);
    try {
      const res = await onPush();
      setHint(res.ok ? "Pushed." : (res.detail ?? "Push failed"));
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const runPr = async () => {
    if (!onOpenPr) return;
    setMenuOpen(false);
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
    setMenuOpen(false);
    if (primary === "commit" || primary === "commit_push") {
      setPending(primary === "commit_push" ? "commit_push" : "commit");
      setOpen(true);
      return;
    }
    if (primary === "push") void runPush();
    if (primary === "create_pr") void runPr();
  };

  const disabled = !!busy || working;

  const submitPending = () => {
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
  };

  return (
    <div className="git-actions" ref={rootRef}>
      <Button
        variant="secondary"
        size="sm"
        icon={<CommitIcon />}
        loading={working}
        disabled={disabled || (primary === "commit" && !dirty && !open)}
        aria-label={primaryLabel}
        title={primaryLabel}
        onClick={primaryClick}
      >
        {!compact && <span className="topbar-action-label">{primaryLabel}</span>}
      </Button>
      <div className="git-menu">
        <button
          type="button"
          className="git-menu-trigger"
          aria-label="More git actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={() => {
            setOpen(false);
            setMenuOpen((v) => !v);
          }}
        >
          <ChevronDownIcon />
        </button>
        {menuOpen && (
          <div className="git-menu-panel" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={disabled || !dirty}
              onClick={() => {
                setMenuOpen(false);
                setPending("commit");
                setOpen(true);
              }}
            >
              Commit…
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled || !dirty || !hasRemote}
              onClick={() => {
                setMenuOpen(false);
                setPending("commit_push");
                setOpen(true);
              }}
            >
              Commit &amp; push…
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled || dirty || !hasRemote}
              onClick={() => void runPush()}
            >
              Push
            </button>
            {canPr && onOpenPr && (
              <button type="button" role="menuitem" disabled={disabled} onClick={() => void runPr()}>
                Create PR…
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="git-commit-popover">
          <input
            autoFocus
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && message.trim()) submitPending();
              if (e.key === "Escape") setOpen(false);
            }}
            disabled={working}
          />
          <div className="actions">
            <Button
              variant="primary"
              size="sm"
              disabled={!message.trim() || working}
              onClick={submitPending}
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
