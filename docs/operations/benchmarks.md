# Measurements

Recorded numbers for the budgets that gate releases. Update when they change;
an unmeasured gate is not a gate.

## Packaged size — [ADR 0006](../adr/0006-size-budget-tauri.md)

Budget: **< 150 MB** per platform.

| Artifact | Size | Date | Notes |
| --- | --- | --- | --- |
| `Divisio.app` (macOS arm64) | **8.3 MB** | 2026-08-06 | Tauri shell + web UI |
| `Divisio_0.0.0_aarch64.dmg` | **2.9 MB** | 2026-08-06 | Compressed installer |

The daemon is **not yet bundled** — the shell currently requires Bun on PATH.
A compiled Bun sidecar adds roughly 58 MB (see ADR 0008), which projects to
about **66 MB** packaged: well inside the budget, with room for a bundled mono
font and future adapters.

Reproduce with `bun run build:desktop`, then measure the bundle under
`apps/desktop/src-tauri/target/release/bundle/`.

## Latency — [ADR 0007](../adr/0007-performance-release-gates.md)

Budgets in [performance.md](../architecture/performance.md).

| Metric | Budget | Measured | Notes |
| --- | --- | --- | --- |
| Daemon ready | ≤ 500ms | not measured | |
| Thread switch | ≤ 100ms | not measured | Needs a seeded 1k-message thread |
| First stream token | ≤ 100ms after adapter emits | not measured | Must exclude provider CLI startup, which dominates wall-clock and is not ours to fix |
| Interrupt acknowledged | ≤ 150ms status flip | ~400ms to command result | The `stopping` status flip is immediate; the result waits for the process to exit. Measure the flip, which is what the budget describes |

Instrumenting these is outstanding work. Until then ADR 0007 cannot be
enforced, because there is nothing to enforce it against.
