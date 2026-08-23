import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "./ui/Button.tsx";
import { ChevronDownIcon, CloseIcon, CommitIcon, CopyIcon } from "./ui/icons.ts";

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

type GitNotice = {
  tone: "ok" | "error";
  title: string;
  detail: string;
};

function fail(title: string, detail?: string | null): GitNotice {
  return { tone: "error", title, detail: (detail ?? "").trim() || "Something went wrong." };
}

function ok(title: string, detail = ""): GitNotice {
  return { tone: "ok", title, detail };
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
  const [hint, setHint] = useState<GitNotice | null>(null);
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<"commit" | "commit_push" | "pr" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const copiedAt = useRef(0);
  const [copied, setCopied] = useState(false);

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

  const commitTitle =
    pending === "pr" ? "Commit & open PR" : pending === "commit_push" ? "Commit & push" : "Commit";

  useEffect(() => {
    if (!open) {
      setMessage("");
      setPending(null);
    }
  }, [open]);

  useEffect(() => {
    if (hint?.tone !== "ok") return;
    const t = window.setTimeout(() => setHint(null), 2400);
    return () => window.clearTimeout(t);
  }, [hint]);

  useEffect(() => {
    if (!menuOpen && !open && !hint) return;
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
        setHint(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, open, hint]);

  const copyDetail = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      copiedAt.current = Date.now();
      setCopied(true);
      window.setTimeout(() => {
        if (Date.now() - copiedAt.current >= 1200) setCopied(false);
      }, 1300);
    } catch {
      /* clipboard can be denied */
    }
  };

  const runCommit = async (alsoPush: boolean) => {
    const msg = message.trim();
    if (!msg) return;
    setWorking(true);
    setHint(null);
    try {
      const committed = await onCommit(msg);
      if (!committed.ok) {
        setHint(fail("Couldn't commit", committed.detail));
        return;
      }
      if (alsoPush) {
        const pushed = await onPush();
        if (!pushed.ok) {
          setHint(fail("Committed, but push failed", pushed.detail));
          return;
        }
        setOpen(false);
        setMessage("");
        setHint(ok("Committed and pushed"));
      } else {
        setOpen(false);
        setMessage("");
        setHint(ok("Committed"));
      }
    } catch (err) {
      setHint(fail("Couldn't commit", err instanceof Error ? err.message : String(err)));
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
      setHint(res.ok ? ok("Pushed") : fail("Couldn't push", res.detail));
    } catch (err) {
      setHint(fail("Couldn't push", err instanceof Error ? err.message : String(err)));
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
        setHint(fail("Commit before opening a PR", res.detail));
        return;
      }
      if (res.status === "error") {
        setHint(fail("Couldn't open a pull request", res.detail));
        return;
      }
      setHint(ok(res.url ? "Pull request opened" : res.compareUrl ? "Pushed — finish on GitHub" : "Done"));
    } catch (err) {
      setHint(fail("Couldn't open a pull request", err instanceof Error ? err.message : String(err)));
    } finally {
      setWorking(false);
    }
  };

  const primaryClick = () => {
    setMenuOpen(false);
    if (primary === "commit" || primary === "commit_push") {
      setHint(null);
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
          if (res.status === "error" || res.status === "needs_commit") {
            setHint(fail("Couldn't open a pull request", res.detail));
            return;
          }
          setOpen(false);
          setHint(ok(res.url ? "Pull request opened" : "Done"));
        } catch (err) {
          setHint(fail("Couldn't open a pull request", err instanceof Error ? err.message : String(err)));
        } finally {
          setWorking(false);
        }
      })();
    } else {
      void runCommit(pending === "commit_push");
    }
  };

  const renderNotice = (item: GitNotice, inPopover: boolean) => (
    <div
      className={`git-result git-result-${item.tone}${inPopover ? " is-inline" : ""}`}
      role={item.tone === "error" ? "alert" : "status"}
    >
      <div className="git-result-head">
        <span className="git-result-title">{item.title}</span>
        <div className="git-result-tools">
          {item.tone === "error" && item.detail && (
            <IconButton
              label={copied ? "Copied" : "Copy error"}
              icon={<CopyIcon />}
              size="sm"
              onClick={() => void copyDetail(item.detail)}
            />
          )}
          {!inPopover && (
            <IconButton label="Dismiss" icon={<CloseIcon />} size="sm" onClick={() => setHint(null)} />
          )}
        </div>
      </div>
      {item.detail ? <pre className="git-result-body">{item.detail}</pre> : null}
    </div>
  );

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
                setHint(null);
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
                setHint(null);
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
          <div className="git-commit-kicker">{commitTitle}</div>
          <label className="git-commit-label" htmlFor="git-commit-msg">
            Message
          </label>
          <textarea
            id="git-commit-msg"
            className="field git-commit-field"
            autoFocus
            rows={3}
            placeholder="What did you change?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && message.trim()) {
                e.preventDefault();
                submitPending();
              }
            }}
            disabled={working}
          />
          {hint?.tone === "error" && renderNotice(hint, true)}
          <div className="git-commit-actions">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!message.trim() || working}
              onClick={submitPending}
            >
              {pending === "pr" ? "Commit & PR" : pending === "commit_push" ? "Commit & push" : "Commit"}
            </Button>
          </div>
        </div>
      )}
      {!open && hint && renderNotice(hint, false)}
    </div>
  );
}
