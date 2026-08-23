import { useState } from "react";
import { CheckIcon } from "../ui/icons.ts";
import {
  BASE_FONT_RANGE,
  loadBaseFontPx,
  loadDensity,
  loadTheme,
  setBaseFontPx,
  setDensityPreference,
  setThemePreference,
  type Density,
  type ThemePreference,
} from "../../themePrefs.ts";

const MODES: { id: ThemePreference; label: string; detail: string }[] = [
  { id: "system", label: "System", detail: "Match the OS appearance" },
  { id: "light", label: "Light", detail: "Always use the light palette" },
  { id: "dark", label: "Dark", detail: "Always use the dark palette" },
];

const DENSITIES: { id: Density; label: string; detail: string }[] = [
  { id: "compact", label: "Compact", detail: "Tighter rows — more on screen" },
  { id: "comfortable", label: "Comfortable", detail: "The default spacing" },
  { id: "spacious", label: "Spacious", detail: "Looser rows, easier to scan" },
];

/** Appearance — color mode, density, and type size, all persisted locally. */
export function AppearanceSettings() {
  const [pref, setPref] = useState<ThemePreference>(() => loadTheme());
  const [density, setDensity] = useState<Density>(() => loadDensity());
  const [fontPx, setFontPx] = useState<number>(() => loadBaseFontPx());

  const select = (next: ThemePreference) => {
    setThemePreference(next);
    setPref(next);
  };

  return (
    <div className="settings-section">
      <div className="settings-group">
        <h4 className="settings-group-title">Color mode</h4>
        <div className="settings-rows" role="radiogroup" aria-label="Color mode">
          {MODES.map((mode) => {
            const active = pref === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`settings-row settings-row-button${active ? " is-selected" : ""}`}
                onClick={() => select(mode.id)}
              >
                <div className="settings-row-copy">
                  <span className="settings-row-label">{mode.label}</span>
                  <span className="settings-row-meta">{mode.detail}</span>
                </div>
                {active ? <CheckIcon className="lucide settings-row-check" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">Density</h4>
        <div className="settings-rows" role="radiogroup" aria-label="Density">
          {DENSITIES.map((option) => {
            const active = density === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`settings-row settings-row-button${active ? " is-selected" : ""}`}
                onClick={() => {
                  setDensityPreference(option.id);
                  setDensity(option.id);
                }}
              >
                <div className="settings-row-copy">
                  <span className="settings-row-label">{option.label}</span>
                  <span className="settings-row-meta">{option.detail}</span>
                </div>
                {active ? <CheckIcon className="lucide settings-row-check" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">Base font size</h4>
        <div className="settings-rows">
          <label className="settings-row">
            <div className="settings-row-copy">
              <span className="settings-row-label">Text size</span>
              <span className="settings-row-meta">
                Scales the whole type ramp. Density is separate — it moves spacing, not text.
              </span>
            </div>
            <input
              type="range"
              min={BASE_FONT_RANGE.min}
              max={BASE_FONT_RANGE.max}
              step={1}
              value={fontPx}
              aria-label="Base font size in pixels"
              onChange={(e) => {
                const next = Number(e.target.value);
                setBaseFontPx(next);
                setFontPx(next);
              }}
            />
            <span className="settings-row-meta">{fontPx}px</span>
          </label>
        </div>
      </div>
    </div>
  );
}
