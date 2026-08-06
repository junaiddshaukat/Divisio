# Measurements

Recorded numbers for the budgets that gate releases. An unmeasured gate is not
a gate, so every figure here comes from a command anyone can rerun.

Measured on macOS arm64, 2026-08-06.

## Packaged size — [ADR 0006](../adr/0006-size-budget-tauri.md)

Budget: **< 150 MB** per platform.

| Artifact | Size | Notes |
| --- | --- | --- |
| `Divisio.app` | **66 MB** | Shell, web UI, and the bundled daemon |
| `Divisio_0.0.0_aarch64.dmg` | **24 MB** | Compressed installer |
| ↳ `divisio-daemon` inside the app | 58 MB | Compiled with `bun build --compile` |
| ↳ Tauri shell + web UI | 8 MB | |

**56% of the budget used**, with the daemon bundled — the app no longer requires
Bun on the user's machine.

Reproduce:

```bash
bun run build:desktop            # compiles the daemon, then bundles
du -sh apps/desktop/src-tauri/target/release/bundle/macos/Divisio.app
```

On macOS the DMG step runs Finder AppleScript for window cosmetics, which fails
without automation permission. `CI=true bun run build:desktop` skips that step
and produces the same artifacts.

## Web bundle

The editor is lazy: Monaco is fetched the first time the file pane opens, so
users who never open a file do not pay for it.

| What loads | Size | When |
| --- | --- | --- |
| App shell (JS + CSS) | **236 KB** | First paint |
| Monaco + language workers | ~4 MB, split across chunks | First time the file pane opens |

Reproduce with `bun run build`, then read `apps/web/dist/index.html` for what is
referenced eagerly. A jump in the eager figure means something imported the
editor at the top level again.

## Latency — [ADR 0007](../adr/0007-performance-release-gates.md)

Reproduce with `bun apps/server/src/bench.ts`. Exits non-zero when a budget is
exceeded, so it can gate a release.

| Metric | Budget | p50 | p95 | |
| --- | --- | --- | --- | --- |
| Thread switch, 1000-message thread | 100ms | 0.6ms | 1.4ms | PASS |
| Turn dispatch → first delta | 100ms | 10.9ms | 16.4ms | PASS |
| Event append + projection | 10ms | <0.1ms | <0.1ms | PASS |
| Daemon start, warm page cache | 500ms | 23.4ms | 23.6ms | PASS |

Also observed:

- **First launch after install: 151ms.** A one-off cost of paging the 58 MB
  binary in from disk. Reported separately because averaging it with warm starts
  would misrepresent both.
- **Projection rebuild: 6ms for 1404 events.** The recovery path after a
  projection bug is cheap enough to run without ceremony.

### What these numbers do and do not cover

The streaming figure measures **our** path — command dispatch, event append,
projection, and delivery to the transport — using a synthetic adapter that emits
immediately.

It deliberately excludes provider CLI startup. A real Claude Code turn takes
around **5 seconds** to first token, and essentially all of that is the vendor
process starting. Including it would produce a number that looks terrible,
cannot be improved by any change to this codebase, and would hide a genuine
regression in the part we control.

Not yet measured: UI paint latency (React render through to pixels) and
behaviour under several concurrently streaming lanes. Both matter and neither is
covered here.
