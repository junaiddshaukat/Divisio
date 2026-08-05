# ADR 0008: Bun as the daemon runtime

## Status

Accepted — amends [ADR 0002](0002-typescript-daemon-web.md), which left the runtime as "pnpm or bun, chosen at Phase 0 code start"

## Context

[ADR 0006](0006-size-budget-tauri.md) makes a packaged desktop artifact under 150 MB a hard release gate. The desktop shell is Tauri wrapping the web UI and supervising the daemon as a sidecar. The daemon runtime is therefore a size decision as much as a performance one, and leaving it open while gating on size was incoherent.

Measured on this machine (macOS arm64, August 2026):

| Runtime | Binary size |
| --- | --- |
| Node v24.12.0 | **112 MB** |
| Bun 1.3.1 | **58 MB** |
| Bun `--compile` hello world | **58 MB** |

Against a 150 MB ceiling, with a Tauri shell at roughly 5–15 MB:

- Node sidecar: ~112 MB + application code ≈ 125–135 MB. Technically passing, with no headroom for a bundled mono font, adapters, or growth
- Bun sidecar: ~58 MB + application code ≈ 70–80 MB. Roughly half the budget left

Native module compatibility was tested directly rather than taken from documentation, because the published guidance is contradictory:

| Module | Node 24 | Bun 1.3.1 |
| --- | --- | --- |
| `better-sqlite3` | PASS | **Hard panic** — `NAPI FATAL ERROR: Error::New napi_get_last_error_info`, crashes the process, not catchable |
| `bun:sqlite` | n/a | PASS |
| `ws` | PASS | PASS |
| `node-pty` (module load) | PASS | PASS |

The `better-sqlite3` panic is not a caught exception. It takes the whole process down, which for a daemon supervising live agent sessions is unacceptable.

Prior art in the category: agent CLIs increasingly ship as compiled single binaries rather than requiring a runtime on the user's machine, and Bun is a common choice for that path. Desktop competitors that prioritize footprint pair a native shell with a compiled core.

## Decision

**Bun is the daemon runtime**, with its own primitives instead of the Node native-addon ecosystem.

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Bun (>= 1.3.1) | Half the binary size of Node under the ADR 0006 gate |
| Package manager | Bun workspaces | One tool; no separate pnpm |
| SQLite | **`bun:sqlite`** | Built in, no native addon, and `better-sqlite3` hard-panics under Bun |
| WebSocket server | Bun's built-in server | No `ws` dependency; native upgrade handling |
| Desktop packaging | `bun build --compile` sidecar inside Tauri 2 | Single binary, counted inside the 150 MB budget |
| Web build | Vite + React | Unchanged |

**`better-sqlite3` is prohibited in this repo.** The storage layer targets `bun:sqlite` only.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `node-pty` under Bun is unverified beyond module load — a PTY spawn could hit the same N-API error path that crashes on `better-sqlite3` | PTY is the **last** adapter tier and lands in Phase 4. Prove it with a spike before committing. If it panics, run the PTY host as a separate supervised process so a crash cannot take the daemon with it |
| Some npm package pulls in a native addon transitively | Keep the dependency list small and audit additions. Prefer Bun built-ins over npm for anything touching the filesystem, sockets, or SQLite |
| Bun-specific APIs make a future move back to Node expensive | Confine Bun-specific calls to `packages/shared` and the storage layer. Contracts, orchestration logic, and adapters stay portable TypeScript |
| Bun regressions on a fast release cadence | Pin the Bun version in `package.json` `engines` and in CI |

## Consequences

- Desktop artifact has roughly 70 MB of headroom instead of 15 MB
- No `node-gyp` build step, so no compiler toolchain requirement for contributors
- `bun:sqlite` is a different API surface from `better-sqlite3`; the storage layer is written against it from the start rather than ported later
- The PTY tier carries a real unresolved risk that must be spiked before Phase 4 planning is trusted
- ADR 0002's open toolchain question is now closed

See [performance](../architecture/performance.md) and [ADR 0006](0006-size-budget-tauri.md).
