# ADR 0006: Install size budget — prefer Tauri shell

## Status

Accepted (amends [ADR 0002](0002-typescript-daemon-web.md))

## Context

Comparable desktop tools in this category ship around **~150 MB**. Users notice install and update weight. Electron apps commonly exceed that because they bundle Chromium. We still want a desktop app wrapping the same web UI + local daemon.

## Decision

- **Hard budget:** packaged desktop artifact **under 150 MB** per platform build (uncompressed app bundle / installer primary artifact — document exact measurement in release notes)
- **Default desktop shell:** **Tauri 2** (system WebView) wrapping `apps/web` and supervising the Node/Bun daemon — not Electron, unless a later ADR proves Tauri cannot meet requirements
- **ADR 0002 update:** “Electron in Phase 3” is replaced by “Tauri (thin shell) in Phase 3”
- Web-first development unchanged — desktop remains a host

## Consequences

- Smaller downloads; competitive install footprint
- Platform WebView differences must be tested (macOS/Windows/Linux)
- Daemon may still ship as a sidecar binary — count it inside the 150 MB budget
- If budget is breached, cut bundled assets and native deps before switching back to Electron
