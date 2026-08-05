# ADR 0007: Performance targets are release gates

## Status

Accepted

## Context

This is a tool people keep open all day and touch hundreds of times. Start, switch, stream, and interrupt are the four actions that define whether it feels alive. Treating latency as something to tune later reliably produces a product that is merely acceptable, because by then the slow parts are load-bearing.

Latency is a quality bar, not a moat — it is copyable and a user cannot verify it from a screenshot. We hold it because the product is unpleasant without it.

## Decision

- Treat [performance.md](../architecture/performance.md) targets as **release gates** from Phase 0 onward, not aspirations
- Prefer fewer WS bytes, simpler transcript rendering, and zero animation on high-frequency paths
- Add size and smoke perf checks before calling a desktop release "done"
- When a tradeoff appears (feature vs jank), **ship the faster path** and file a follow-up

## Consequences

- Some visual flourish is intentionally skipped
- Virtualization turns on above a measured message-count threshold, not by default for small threads
- Contributors must not "polish" with perpetual CSS animations on the chat view
- A release that misses a budget does not ship until the budget is met or explicitly revised by ADR
