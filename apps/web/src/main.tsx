import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

/** Theme resolves from the OS by default; MVP ships `system`. */
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const apply = (isDark: boolean) => document.documentElement.classList.toggle("dark", isDark);
apply(dark.matches);
dark.addEventListener("change", (e) => {
  // Flash-guard: snap colors instead of tweening them through mud.
  document.documentElement.classList.add("no-transitions");
  apply(e.matches);
  requestAnimationFrame(() => document.documentElement.classList.remove("no-transitions"));
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
