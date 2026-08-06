const LEFT_KEY = "divisio:left-panel-width";
const RIGHT_KEY = "divisio:right-panel-width";
const TERMINAL_KEY = "divisio:terminal-dock-height";

export const LEFT_DEFAULT = 260;
export const RIGHT_DEFAULT = 420;
export const LEFT_MIN = 200;
export const LEFT_MAX = 400;
export const RIGHT_MIN = 320;
export const RIGHT_MAX_RATIO = 0.7;

export const TERMINAL_DEFAULT = 220;
export const TERMINAL_MIN = 120;
export const TERMINAL_MAX = 420;

export function loadWidth(key: "left" | "right", fallback: number): number {
  try {
    const raw = localStorage.getItem(key === "left" ? LEFT_KEY : RIGHT_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export function saveWidth(key: "left" | "right", value: number): void {
  try {
    localStorage.setItem(key === "left" ? LEFT_KEY : RIGHT_KEY, String(Math.round(value)));
  } catch {
    /* private mode */
  }
}

export function loadTerminalHeight(fallback = TERMINAL_DEFAULT): number {
  try {
    const raw = localStorage.getItem(TERMINAL_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? clampTerminal(n) : fallback;
  } catch {
    return fallback;
  }
}

export function saveTerminalHeight(value: number): void {
  try {
    localStorage.setItem(TERMINAL_KEY, String(Math.round(clampTerminal(value))));
  } catch {
    /* private mode */
  }
}

export function clampLeft(w: number): number {
  return Math.min(LEFT_MAX, Math.max(LEFT_MIN, w));
}

export function clampRight(w: number, viewport = window.innerWidth): number {
  const max = Math.floor(viewport * RIGHT_MAX_RATIO);
  return Math.min(max, Math.max(RIGHT_MIN, w));
}

export function clampTerminal(h: number): number {
  // Leave room for topbar + prompt; never let the dock own most of the window.
  const max = Math.min(TERMINAL_MAX, Math.floor(window.innerHeight * 0.4));
  return Math.min(max, Math.max(TERMINAL_MIN, h));
}
