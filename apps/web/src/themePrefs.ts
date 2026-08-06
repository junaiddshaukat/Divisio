/**
 * Color mode preference — System / Light / Dark.
 * Cursor/Codex-class standard: one mode, persisted locally; no theme packs.
 */

export type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "divisio:theme";

export function loadTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* private mode */
  }
  return "system";
}

export function saveTheme(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode */
  }
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(pref: ThemePreference, systemDark = systemPrefersDark()): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return systemDark;
}

function snapDark(isDark: boolean): void {
  // Flash-guard: snap colors instead of tweening them through mud.
  document.documentElement.classList.add("no-transitions");
  document.documentElement.classList.toggle("dark", isDark);
  requestAnimationFrame(() => document.documentElement.classList.remove("no-transitions"));
  window.dispatchEvent(new CustomEvent("divisio:theme", { detail: { dark: isDark } }));
}

/** Apply the current (or given) preference to `<html>`. */
export function applyThemePreference(pref: ThemePreference = loadTheme()): void {
  snapDark(resolveDark(pref));
}

/** Persist and apply. Used by Settings → Appearance. */
export function setThemePreference(pref: ThemePreference): void {
  saveTheme(pref);
  applyThemePreference(pref);
}
