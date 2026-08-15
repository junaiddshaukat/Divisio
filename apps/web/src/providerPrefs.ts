/**
 * Per-provider display overrides (name + accent + enabled). Client-only — does
 * not change adapter identity on the wire.
 */

const KEY = "divisio:provider-prefs";

export type ProviderAccent =
  | "blue"
  | "green"
  | "orange"
  | "red"
  | "purple"
  | "teal"
  | "default";

export interface ProviderPref {
  displayName?: string;
  accent?: ProviderAccent;
  /** When false, hidden from new-thread / picker surfaces. Default true. */
  enabled?: boolean;
}

export type ProviderPrefsMap = Record<string, ProviderPref>;

export const ACCENT_SWATCHES: { id: ProviderAccent; color: string; label: string }[] = [
  { id: "default", color: "transparent", label: "Brand" },
  { id: "blue", color: "#3b82f6", label: "Blue" },
  { id: "green", color: "#22c55e", label: "Green" },
  { id: "orange", color: "#f97316", label: "Orange" },
  { id: "red", color: "#ef4444", label: "Red" },
  { id: "purple", color: "#a855f7", label: "Purple" },
  { id: "teal", color: "#14b8a6", label: "Teal" },
];

export function loadProviderPrefs(): ProviderPrefsMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ProviderPrefsMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveProviderPrefs(prefs: ProviderPrefsMap): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent("divisio:provider-prefs"));
}

function isEmptyPref(p: ProviderPref | undefined): boolean {
  if (!p) return true;
  const noName = !p.displayName?.trim();
  const noAccent = !p.accent || p.accent === "default";
  const enabled = p.enabled !== false;
  return noName && noAccent && enabled;
}

export function setProviderPref(kind: string, patch: ProviderPref): ProviderPrefsMap {
  const next = { ...loadProviderPrefs() };
  const merged: ProviderPref = { ...next[kind], ...patch };
  if (isEmptyPref(merged)) {
    delete next[kind];
  } else {
    next[kind] = {
      ...(merged.displayName?.trim() ? { displayName: merged.displayName.trim() } : {}),
      ...(merged.accent && merged.accent !== "default" ? { accent: merged.accent } : {}),
      ...(merged.enabled === false ? { enabled: false } : {}),
    };
  }
  saveProviderPrefs(next);
  return next;
}

export function displayLabel(kind: string, fallback: string, prefs = loadProviderPrefs()): string {
  return prefs[kind]?.displayName?.trim() || fallback;
}

export function accentFor(kind: string, prefs = loadProviderPrefs()): ProviderAccent {
  return prefs[kind]?.accent ?? "default";
}

export function isProviderEnabled(kind: string, prefs = loadProviderPrefs()): boolean {
  return prefs[kind]?.enabled !== false;
}
