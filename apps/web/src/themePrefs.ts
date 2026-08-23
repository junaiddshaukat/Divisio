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

/* -------------------------------- density --------------------------------
 * `--density-scale` has been in foundation.css since the layout spec, but
 * nothing ever wrote it, so the control the design docs describe did not
 * exist. Values match docs/design/layout.md exactly.
 */

export type Density = "compact" | "comfortable" | "spacious";

const DENSITY_KEY = "divisio:density";
const DENSITY_SCALE: Record<Density, number> = {
  compact: 0.85,
  comfortable: 1,
  spacious: 1.15,
};

export function loadDensity(): Density {
  try {
    const raw = localStorage.getItem(DENSITY_KEY);
    if (raw === "compact" || raw === "comfortable" || raw === "spacious") return raw;
  } catch {
    /* private mode */
  }
  return "comfortable";
}

/** Density scales spacing and control geometry only — never type size. */
export function applyDensity(density: Density): void {
  document.documentElement.style.setProperty("--density-scale", String(DENSITY_SCALE[density]));
}

export function setDensityPreference(density: Density): void {
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* private mode */
  }
  applyDensity(density);
}

/* ------------------------------- base font -------------------------------
 * Type size is deliberately a separate axis from density: someone who wants
 * more rows on screen is not necessarily someone who wants smaller text.
 */

const FONT_KEY = "divisio:baseFontPx";
const FONT_MIN = 11;
const FONT_MAX = 18;
const FONT_DEFAULT = 13;

/** Type scale, expressed as offsets from the base so ratios hold at any size. */
const TYPE_OFFSETS: Record<string, number> = {
  "--text-micro": -3,
  "--text-meta": -2,
  "--text-ui": 0,
  "--text-body": 0,
  "--text-lead": 2,
  "--text-display": 15,
};

export function loadBaseFontPx(): number {
  try {
    const raw = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX) return raw;
  } catch {
    /* private mode */
  }
  return FONT_DEFAULT;
}

export function applyBaseFontPx(px: number): void {
  const base = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
  const root = document.documentElement.style;
  for (const [token, offset] of Object.entries(TYPE_OFFSETS)) {
    root.setProperty(token, `${base + offset}px`);
  }
  // `body` sits one step above chat chrome; keep that relationship.
  root.setProperty("--text-base", `${base + 1}px`);
}

export function setBaseFontPx(px: number): void {
  const base = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
  try {
    localStorage.setItem(FONT_KEY, String(base));
  } catch {
    /* private mode */
  }
  applyBaseFontPx(base);
}

export const BASE_FONT_RANGE = { min: FONT_MIN, max: FONT_MAX, default: FONT_DEFAULT };

/** Apply persisted appearance prefs. Called once at boot, before first paint. */
export function applyStoredAppearance(): void {
  applyDensity(loadDensity());
  applyBaseFontPx(loadBaseFontPx());
}
