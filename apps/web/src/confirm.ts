/**
 * In-app confirmations.
 *
 * Native Tauri dialogs cannot host a "Don't show again" checkbox, and they
 * also patch `window.confirm` onto a permissioned plugin — so destructive
 * confirms always go through this host instead.
 */

export type ConfirmKind = "danger" | "warning";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Primary button label. */
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: ConfirmKind;
  /**
   * When set, the dialog offers "Don't show again". A later call with the same
   * key skips the dialog and resolves `true`.
   */
  rememberKey?: string;
}

type Presenter = (opts: ConfirmOptions) => Promise<boolean>;

let presenter: Presenter | null = null;

const SKIP_PREFIX = "divisio:skip-confirm:";

export function skipConfirmKey(rememberKey: string): string {
  return `${SKIP_PREFIX}${rememberKey}`;
}

export function isConfirmSkipped(rememberKey: string): boolean {
  try {
    return localStorage.getItem(skipConfirmKey(rememberKey)) === "1";
  } catch {
    return false;
  }
}

export function setConfirmSkipped(rememberKey: string, skipped: boolean) {
  try {
    if (skipped) localStorage.setItem(skipConfirmKey(rememberKey), "1");
    else localStorage.removeItem(skipConfirmKey(rememberKey));
  } catch {
    /* private mode */
  }
}

/** Mounted once by `ConfirmHost`. */
export function registerConfirmPresenter(next: Presenter | null): void {
  presenter = next;
}

/**
 * Ask before a destructive action. Resolves true when the user confirms.
 */
export async function confirmDanger(
  message: string,
  title = "Confirm",
  opts?: Omit<ConfirmOptions, "title" | "message">,
): Promise<boolean> {
  const rememberKey = opts?.rememberKey;
  if (rememberKey && isConfirmSkipped(rememberKey)) return true;

  const request: ConfirmOptions = {
    title,
    message,
    confirmLabel: opts?.confirmLabel ?? "Yes",
    cancelLabel: opts?.cancelLabel ?? "No",
    kind: opts?.kind ?? "warning",
    rememberKey,
  };

  if (presenter) return presenter(request);

  // Host not mounted yet (tests / early boot) — last-resort browser confirm.
  return window.confirm(`${title}\n\n${message}`);
}
