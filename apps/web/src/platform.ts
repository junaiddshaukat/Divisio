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
