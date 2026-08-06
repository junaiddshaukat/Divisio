# ADR 0008: Bun as the daemon runtime

## Status

Accepted — amends [ADR 0002](0002-typescript-daemon-web.md), which left the runtime as "pnpm or bun, chosen at Phase 0 code start"

## Context

[ADR 0006](0006-size-budget-tauri.md) makes a packaged desktop artifact under 150 MB a hard release gate. The desktop shell is Tauri wrapping the web UI and supervising the daemon as a sidecar. The daemon runtime is therefore a size decision as much as a performance one, and leaving it open while gating on size was incoherent.

Measured on this machine (macOS arm64, August 2026):

| Runtime | Binary size |
| --- | --- |
| Node v24.12.0 | **112 MB** |
| Bun 1.3.5 | **~58 MB** |
| Bun `--compile` hello world | **~58 MB** |

Against a 150 MB ceiling, with a Tauri shell at roughly 5–15 MB:

- Node sidecar: ~112 MB + application code ≈ 125–135 MB. Technically passing, with no headroom for a bundled mono font, adapters, or growth
- Bun sidecar: ~58 MB + application code ≈ 70–80 MB. Roughly half the budget left

Native module compatibility was tested directly rather than taken from documentation, because the published guidance is contradictory:

| Module | Node 24 | Bun 1.3.5 |
| --- | --- | --- |
| `better-sqlite3` | PASS | **Hard panic** — `NAPI FATAL ERROR: Error::New napi_get_last_error_info`, crashes the process, not catchable |
| `bun:sqlite` | n/a | PASS |
| `ws` | PASS | PASS |
| `node-pty` | PASS | Loads under checkout Bun, **fails inside `bun build --compile`** (`/$bunfs`); also historically had broken `onData` under Bun |
| `Bun.Terminal` / `Bun.spawn({ terminal })` | n/a | PASS (since 1.3.5), works in compiled sidecars |

The `better-sqlite3` panic is not a caught exception. It takes the whole process down, which for a daemon supervising live agent sessions is unacceptable.

Prior art in the category: agent CLIs increasingly ship as compiled single binaries rather than requiring a runtime on the user's machine, and Bun is a common choice for that path. Desktop competitors that prioritize footprint pair a native shell with a compiled core.

## Decision

**Bun is the daemon runtime**, with its own primitives instead of the Node native-addon ecosystem.

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Bun (>= 1.3.5) | Half the binary size of Node under the ADR 0006 gate; ships `Bun.Terminal` |
| Package manager | Bun workspaces | One tool; no separate pnpm |
| SQLite | **`bun:sqlite`** | Built in, no native addon, and `better-sqlite3` hard-panics under Bun |
| WebSocket server | Bun's built-in server | No `ws` dependency; native upgrade handling |
| PTY / terminals | **`Bun.spawn({ terminal })`** | Works inside `--compile`; `node-pty` cannot resolve natives from `/$bunfs` |
| Desktop packaging | `bun build --compile` sidecar inside Tauri 2 | Single binary, counted inside the 150 MB budget |
| Web build | Vite + React | Unchanged |

**`better-sqlite3` is prohibited in this repo.** The storage layer targets `bun:sqlite` only.

**`node-pty` is prohibited in this repo.** Terminals use Bun's built-in PTY.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Bun PTY maturity / Windows ConPTY gaps | Soft-fail via `terminalsAvailable()`; daemon stays up if Terminal is missing. Prove with `pty.test.ts` on CI macOS/Linux |
| Some npm package pulls in a native addon transitively | Keep the dependency list small and audit additions. Prefer Bun built-ins over npm for anything touching the filesystem, sockets, or SQLite |
| Bun-specific APIs make a future move back to Node expensive | Confine Bun-specific calls to `packages/shared`, storage, and `apps/server/src/terminal`. Contracts, orchestration logic, and adapters stay portable TypeScript |
| Bun regressions on a fast release cadence | Pin the Bun version in `package.json` `engines` and in CI |

## Consequences

- Desktop artifact has roughly 70 MB of headroom instead of 15 MB
- No `node-gyp` build step, so no compiler toolchain requirement for contributors
- `bun:sqlite` is a different API surface from `better-sqlite3`; the storage layer is written against it from the start rather than ported later
- Packaged desktop terminals work without shipping native addons beside the sidecar
- ADR 0002's open toolchain question is now closed

See [performance](../architecture/performance.md) and [ADR 0006](0006-size-budget-tauri.md).
