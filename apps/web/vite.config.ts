import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and a relative base for asset protocol builds.
  clearScreen: false,
  base: process.env.TAURI_ENV_PLATFORM ? "./" : "/",
  server: {
    port: 5173,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Size is tracked, not gated (ADR 0006 revision). Monaco is legitimately
    // large and lives in its own lazily-loaded chunk; warning about it on every
    // build trains people to ignore build output.
    chunkSizeWarningLimit: 5000,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
