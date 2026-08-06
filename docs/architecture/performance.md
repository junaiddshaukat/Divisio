# Performance

Divisio must feel immediate in daily use: cold start, thread switch, streaming, and interrupt. Perceived speed and measured speed both count, and the budgets below gate releases.

## Targets (initial — tighten with benchmarks in Phase 0)

| Metric | Target | Notes |
| --- | --- | --- |
| Daemon ready (local) | ≤ 500ms after process start on warm machine | Health endpoint up |
| Web UI interactive | ≤ 1.0s to usable shell on warm cache | Empty project list ok |
| Thread switch | ≤ 100ms to paint cached projection | No full reload |
| First stream token visible | ≤ 100ms after adapter emits | WS push path |
| Interrupt acknowledged | ≤ 150ms UI status flip | Adapter may take longer to stop |
| Packaged desktop install size | tracked, not gated | See the revision in [ADR 0006](../adr/0006-size-budget-tauri.md) |
| Steady streaming CPU | No sustained fan spin from CSS/raf loops | Audit animations |

Size is reported rather than enforced: speed and capability come first when they conflict with it. What still matters is *when* bytes are paid — keeping them off the first-paint path is a latency decision, not a size one.

## Known ways this gets slow (avoid)

- Oversized WebSocket payloads / re-sending full snapshots
- Virtualizer measure ↔ scroll feedback loops on transcripts
- Decorative animations on high-frequency actions
- Electron shipping a full Chromium when a system WebView suffices
- Unbounded list re-renders on every token

## Engineering rules

1. **Push deltas, not whole worlds** — domain events and small patches; snapshot only on connect/resync
2. **Transcript path is sacred** — buffer reconnect/approval states without fake “streaming” scroll stick
3. **No animation on keyboard-critical paths** — [design](../design/README.md)
4. **Profile before decorating** — React DevTools / browser perf on streaming turns
5. **Adapter I/O off the UI thread** — daemon owns providers; UI only renders projections
6. **Budget binary size** — Tauri (or equivalent thin shell); no accidental multi-hundred-MB bundles

## Benchmarks (Phase 0+)

Add a small `docs/operations/benchmarks.md` (or scripts) when code exists:

- Cold/warm daemon start
- 1k-message thread open
- Synthetic token stream at N tokens/s
- Packaged `.dmg` / `.app` / Linux artifact size CI check (&lt; 150 MB)

## Related

- [Design](../design/README.md)
- ADR [0004](../adr/0004-event-sourced-orchestration.md), [0006](../adr/0006-size-budget-tauri.md), [0007](../adr/0007-performance-release-gates.md)
