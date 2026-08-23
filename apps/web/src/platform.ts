/**
 * Desktop-only capabilities.
 *
 * The same app runs in a browser on a paired device, where none of this exists.
 * Each capability is probed rather than assumed, so the UI can omit a control
 * instead of offering one that silently does nothing.
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function canPickDirectory(): boolean {
  return isTauri();
}

export function canOpenExternally(): boolean {
  return isTauri();
}

export type OpenExternalTarget = "finder" | "cursor" | "code";
export type OpenExternalResult = "ok" | "unavailable" | "missing" | "failed";

/**
 * Opens the native folder picker. Returns null when cancelled, or when the
 * dialog plugin is unavailable.
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    return typeof selected === "string" ? selected : null;
  } catch {
    // Plugin missing or permission denied: fall back to the text field rather
    // than blocking the user from adding a project at all.
    return null;
  }
}

/** Reloads the window UI only. The daemon is not restarted. */
export function reloadApp(): void {
  window.location.reload();
}

/**
 * Absolute path from a dropped folder, when the shell exposes one.
 * Browsers never give a real path; Tauri/Chromium desktop often set `file.path`.
 */
export function pathFromDroppedFolder(dt: DataTransfer | null): string | null {
  if (!dt?.files?.length && !dt?.items?.length) return null;

  for (const file of Array.from(dt.files ?? [])) {
    const path = (file as File & { path?: string }).path;
    if (typeof path === "string" && path.length > 0) return path;
  }

  // Prefer directory entries when the browser reports them (still no path on web).
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      const file = item.getAsFile() as (File & { path?: string }) | null;
      if (file?.path) return file.path;
    }
  }
  return null;
}

/** Subscribe to native window folder drops (desktop shell). */
export async function listenFolderDrop(
  onPath: (path: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
      if (paths?.[0]) onPath(paths[0]);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

/**
 * Reveal a path in the file manager, or open it in Cursor / VS Code.
 */
export async function openExternal(
  path: string,
  target: OpenExternalTarget,
): Promise<OpenExternalResult> {
  if (!isTauri()) return "unavailable";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external", { path, with: target });
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT|cannot find|No such file|CLI not on PATH/i.test(msg)) return "missing";
    return "failed";
  }
}

export async function copyPath(path: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(path);
    return true;
  } catch {
    return false;
  }
}

/** http(s) and mailto only — agent markdown can otherwise smuggle file: / javascript:. */
export function isSafeExternalUrl(href: string): boolean {
  const url = href.trim();
  if (!url || /[\r\n\0]/.test(url)) return false;
  return /^(https?:\/\/|mailto:)/i.test(url);
}

/** Open a URL in the system browser (desktop) or a new tab (web). */
export async function openUrl(url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) return false;
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_url", { url: url.trim() });
      return true;
    } catch {
      return false;
    }
  }
  window.open(url.trim(), "_blank", "noopener,noreferrer");
  return true;
}

/**
 * Tauri webviews swallow `target="_blank"`. Capture clicks on safe links and
 * hand them to the OS instead — chat, board, settings, everywhere.
 */
export function installExternalLinkOpener(): void {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute("href");
      if (!href || !isSafeExternalUrl(href)) return;
      event.preventDefault();
      void openUrl(href);
    },
    true,
  );
}
