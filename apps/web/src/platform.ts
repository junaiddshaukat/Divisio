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
