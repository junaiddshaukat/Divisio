import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyThemePreference, loadTheme } from "./themePrefs.ts";
import "./index.css";

// Color mode: System / Light / Dark (see themePrefs.ts). Apply before React paints.
applyThemePreference();

const media = window.matchMedia("(prefers-color-scheme: dark)");
media.addEventListener("change", () => {
  // Only chase the OS when the user asked for System.
  if (loadTheme() === "system") applyThemePreference("system");
});

// Desktop shell: native AppKit vibrancy paints the wallpaper behind a clear webview.
const isDesktop =
  "__TAURI_INTERNALS__" in window ||
  "__TAURI__" in window ||
  /Tauri/i.test(navigator.userAgent);
if (isDesktop) {
  document.documentElement.classList.add("desktop-vibrancy");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
