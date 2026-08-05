# ADR 0004: Append-only event log, without the CQRS ceremony

## Status

Accepted — supersedes the original "lightweight event sourcing" decision, which mandated a decider / projector / reactor triad.

## Context

The original version of this ADR named four layers — append-only log, pure decider, projectors, reactors with receipts — before a single token could reach the screen. A Phase 0 spike then ignored all of it and wrote mutable `projects` / `threads` / `messages` tables with no event log at all. That is evidence worth taking seriously: the ceremony was not carrying its weight, and the parts that *are* load-bearing were not distinguished from the parts that were aspiration.

Separating the two requires asking what actually depends on the log:

| Requirement | Needs an append-only log? |
| --- | --- |
| Reconnect without losing or duplicating history | **Yes** — the resume cursor is a `seq` in the log ([ws-protocol](../architecture/ws-protocol.md)) |
| Durable transcript across daemon restart | **Yes** |
| Diff a turn against a checkpoint | **Yes** — needs the turn boundary recorded, not inferred |
| Rebuild read models after a projection bug | **Yes** |
| Multi-client consistency | **Yes** — one ordering everyone agrees on |
| Pure decider functions separated from I/O | No — a testability preference, not a requirement |
| Reactor layer with explicit receipts | No — one writer, no need for the indirection yet |

The log is load-bearing. The framework around it is not.

## Decision

**Keep the append-only event log. Drop the mandated layering.**

### The log

- One append-only `events` table in SQLite, monotonic `seq` per environment assigned at append time
- Events are **immutable once written** — no updates, no deletes, no rewriting history
- Projections (`projects`, `threads`, `messages`, activity) are derived read models, updated in the same transaction as the append, and **fully rebuildable** by replaying the log
- Any state the UI renders comes from a projection, never from a client-side guess

### The code shape

Plain TypeScript modules. Validate the command, append events, update projections, do the I/O. Split a function out when it gets hard to test, not because a pattern requires it. No Effect-first stack, no CQRS framework, no decider/projector/reactor vocabulary imposed on code that does not need it.

If a second writer or a genuine need for replayable side effects appears, revisit with a new ADR.

### Event versioning — mandatory from the first event written

Append-only means past events are permanent. Their meaning can never be changed retroactively, and this is the single most common way event-sourced systems become unmaintainable. Rules:

| Rule | Detail |
| --- | --- |
| **Every event carries `type` and `v`** | `v` is an integer starting at 1. No exceptions, including the first event ever written |
| **Additive changes do not bump `v`** | Adding an optional field readers can ignore is compatible |
| **Anything else bumps `v`** | Removing a field, renaming one, changing a type, changing units, narrowing an enum, or changing what a value *means* |
| **A bump requires an upcaster** | A pure function `(vN) → (vN+1)`, chained to reach current. Written in the same commit as the bump, never later |
| **Upcasting happens at read time** | The stored bytes are never rewritten. A migration that mutates old events is prohibited |
| **Upcasters live in one registry** | Keyed by `type` and `v`, so the full history of a type is readable in one place |
| **Retired types keep their upcasters** | An event type no longer emitted is still readable. Deleting its upcaster breaks replay of old logs permanently |
| **Unknown types: strict on write, tolerant on read** | Reject an unknown type at append. On read, skip with a warning — a newer daemon's events must not brick an older one |

The test that enforces this: **replay a fixture log containing v1 of every event type ever defined, and assert current projections build cleanly.** That fixture only grows. It is the regression net for the whole rule set.

### Payload discipline

- No unbounded payloads. Token deltas are **not** persisted per token — they coalesce into the committed turn ([ws-protocol](../architecture/ws-protocol.md))
- Large artifacts (diffs, file contents, tool output) are stored by reference, not inlined into events
- Secrets and tokens never enter event payloads
- Audit WebSocket fanout when adding an event type — every event is potential broadcast traffic

## Consequences

- Threads survive restarts; reconnect has a cursor to resume from; projections can be rebuilt after a bug
- Less scaffolding to write before Phase 0 shows streaming output — the spike's instinct was right about the ceremony, wrong about the log
- The versioning discipline is real work and is not optional. It is cheap now and impossible to retrofit once users have logs on disk
- Pure-decider testability is available where it helps, not imposed where it does not
- The v1-fixture replay test must exist before the second event version is introduced

See [orchestration](../architecture/orchestration.md) and [ws-protocol](../architecture/ws-protocol.md).
