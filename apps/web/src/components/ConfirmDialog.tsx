import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  registerConfirmPresenter,
  setConfirmSkipped,
  type ConfirmOptions,
} from "../confirm.ts";
import { Button } from "./ui/Button.tsx";

/**
 * Global confirm UI. Registers itself as the presenter for `confirmDanger`.
 * Mount once near the app root.
 */
export function ConfirmHost() {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const [dontShow, setDontShow] = useState(false);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);
  const checkboxId = useId();

  useEffect(() => {
    registerConfirmPresenter((opts) => {
      setDontShow(false);
      setOpen(opts);
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
      });
    });
    return () => registerConfirmPresenter(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const finish = (ok: boolean) => {
    if (ok && dontShow && open?.rememberKey) {
      setConfirmSkipped(open.rememberKey, true);
    }
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOpen(null);
    setDontShow(false);
    resolve?.(ok);
  };

  if (!open) return null;

  const destructive = /delete|remove/i.test(open.confirmLabel ?? open.title);

  return createPortal(
    <div
      className="confirm-backdrop"
      role="presentation"
      onClick={() => finish(false)}
    >
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="confirm-title">
          {open.title}
        </h2>
        <p id="confirm-dialog-body" className="confirm-body">
          {open.message}
        </p>
        {open.rememberKey && (
          <label className="confirm-remember" htmlFor={checkboxId}>
            <input
              id={checkboxId}
              className="confirm-remember-box"
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
            />
            <span className="confirm-remember-label">Don&apos;t show again</span>
          </label>
        )}
        <div className="confirm-foot">
          <Button type="button" variant="ghost" size="sm" onClick={() => finish(false)}>
            {open.cancelLabel ?? "No"}
          </Button>
          <Button
            type="button"
            variant={destructive ? "danger" : "primary"}
            size="sm"
            autoFocus
            onClick={() => finish(true)}
          >
            {open.confirmLabel ?? "Yes"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
