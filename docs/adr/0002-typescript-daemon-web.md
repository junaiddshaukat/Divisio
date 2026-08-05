# ADR 0002: TypeScript daemon + web first

## Status

Accepted (desktop shell amended by [ADR 0006](0006-size-budget-tauri.md); runtime closed by [ADR 0008](0008-bun-runtime.md))

## Context

Products in this category land on either a Node/TS server with a React UI, or a native/Electron shell. We need one stack the team can ship end to end quickly while staying remote-ready later.

## Decision

- **Language:** TypeScript throughout daemon, contracts, and web
- **Daemon:** WebSocket + HTTP local server on Bun ([ADR 0008](0008-bun-runtime.md))
- **UI:** React web first (`apps/web`)
- **Desktop:** Thin native shell in Phase 3 wrapping the same web UI + daemon — **Tauri by default** per ADR 0006 (install size &lt; 150 MB). Electron is not the v1 plan.
- **Mobile:** Deferred
- **Package manager / exact toolchain:** Bun workspaces — decided in [ADR 0008](0008-bun-runtime.md) on measured size and native-module evidence

## Consequences

- Shared contracts package is straightforward
- Desktop does not become a second orchestration implementation
- WebView/platform testing is required for the Tauri shell
