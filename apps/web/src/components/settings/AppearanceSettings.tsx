import { useState } from "react";
import { CheckIcon } from "../ui/icons.ts";
import {
  loadTheme,
  setThemePreference,
  type ThemePreference,
} from "../../themePrefs.ts";

const MODES: { id: ThemePreference; label: string; detail: string }[] = [
  { id: "system", label: "System", detail: "Match the OS appearance" },
  { id: "light", label: "Light", detail: "Always use the light palette" },
  { id: "dark", label: "Dark", detail: "Always use the dark palette" },
];

/** Color mode — System / Light / Dark, persisted locally. */
export function AppearanceSettings() {
  const [pref, setPref] = useState<ThemePreference>(() => loadTheme());

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
    </div>
  );
}
