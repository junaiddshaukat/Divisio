# ADR 0006: Install size budget — prefer Tauri shell

## Status

Accepted, then **relaxed** — see *Revision* below

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


## Revision: size is a metric, not a gate

The 150 MB budget did its job. It forced the runtime decision onto measured
evidence (ADR 0008) and produced a 66 MB app with the daemon bundled — less
than half the ceiling.

It has since started pulling the wrong way. Weighing an editor, a language
server, or a richer surface against megabytes optimises for a number nobody
downloads twice, at the cost of things users feel constantly.

**Revised position:**

- Packaged size is **tracked and reported**, not enforced. A build is never
  blocked for being larger
- **Speed, robustness, and capability come first.** Where they conflict with
  size, size loses
- What still matters is *when* bytes are paid. Deferring work off the
  first-paint path is a latency decision and stays: the editor is prefetched
  during idle so it opens instantly, rather than being withheld to keep a
  bundle small
- The [ADR 0007](0007-performance-release-gates.md) latency budgets remain hard
  gates. Those measure what a user experiences on every action

Deliberately not reverted: the Tauri shell and the compiled daemon. Both were
chosen for startup time and for not requiring a runtime on the user's machine,
which are speed and robustness arguments that hold regardless of size.
