# WebSocket protocol

The single wire between clients and the daemon. Everything the UI knows arrives here; everything the user does leaves here. Contracts live in `packages/contracts` and this document is the specification they implement.

Design constraints, in priority order:

1. **Correct across reconnects.** A dropped socket must never silently lose or duplicate history.
2. **Small on the wire.** Deltas, not snapshots. See [performance](performance.md).
3. **Never blocks the daemon.** A slow client degrades its own view, not the agents.

## Transport and versioning

| Property | Value |
| --- | --- |
| Endpoint | `/ws` on the daemon's HTTP listener |
| Frames | UTF-8 JSON text frames (v1). Binary reserved for future transcript bulk transfer |
| Version | Negotiated via WebSocket subprotocol: `divisio.v1` |
| Keepalive | Native WS ping/pong, server-initiated, 20s interval, 3 missed → close |

Breaking changes mint a new subprotocol (`divisio.v2`). The daemon may accept several concurrently during a migration window. A client that offers no recognized subprotocol is rejected at upgrade — never silently downgraded.

`/health` and the `ready` frame also carry **`generation`**: an integer from `DAEMON_GENERATION` in `packages/contracts`. Desktop attach and the UI refuse a daemon that omits it or reports a smaller number. Command lists on those payloads are documentation, not the attach decision — substring matching on `/health` is how an old process on `:4577` used to get adopted.

## Handshake

The upgrade request carries auth. Checks run in this order, and each rejects before any state is allocated:

| # | Check | Failure |
| --- | --- | --- |
| 1 | `Host` header in allowlist | `403` — DNS-rebinding guard |
| 2 | `Origin` header in allowlist (present and matching) | `403` |
| 3 | Subprotocol includes a supported version | `400` |
| 4 | `Authorization: Bearer <token>` present, timing-safe match | `401` |
| 5 | Token not revoked, not expired | `401` |

Rules and rationale for each live in [security.md](security.md#required-controls-all-of-them-on-every-listener). Two properties matter here: **the token is required on loopback too**, and **it never appears in the URL**. A `401` response body carries no detail about which check failed.

On success the server sends `ready` as the first frame:

```jsonc
{
  "t": "ready",
  "protocol": "divisio.v1",
  "environmentId": "env_01H…",
  "seq": 48213,
  "generation": 1,
  "commands": ["project.list", "turn.send"]
}
```

`seq` is the current head of the event log — the client's starting cursor if it has no prior state. `generation` is the compatibility contract; a missing field means the daemon predates this check and must not be attached.

## Envelope

Every frame is a JSON object with a `t` discriminator.

| `t` | Direction | Purpose |
| --- | --- | --- |
| `req` | client → server | Command dispatch, expects exactly one `res` or `err` |
| `res` | server → client | Success reply, correlated by `id` |
| `err` | server → client | Failure reply, correlated by `id` |
| `evt` | server → client | Unsolicited domain event from the log |
| `sub` | client → server | Change which threads the client receives events for |
| `ready` | server → client | Post-handshake greeting |

```jsonc
// req
{ "t": "req", "id": "c7", "cmd": "turn.send", "payload": { "threadId": "thr_…", "text": "…" } }

// res
{ "t": "res", "id": "c7", "payload": { "turnId": "trn_…" } }

// err
{ "t": "err", "id": "c7", "code": "provider_not_found", "message": "codex is not on PATH", "retryable": false }
```

### Correlation

`id` is client-generated, unique per connection, and echoed on the matching `res`/`err`. Clients time out their own pending requests; a timed-out request is **not** implicitly cancelled — the command may still have committed events. Use `turn.interrupt` to stop work, never a client-side timeout.

`evt` frames carry no `id`. They are never replies.

### Errors

`code` is a stable machine identifier from `packages/contracts`. `message` is human text for the UI and may change. `retryable` tells the client whether resending the identical request is sensible. Full taxonomy is its own doc; this spec fixes only the envelope shape.

## Events and the resume cursor

Every `evt` carries a `seq` from the append-only event log. `seq` is **monotonic per environment** — one counter across all threads, assigned at append time.

```jsonc
{ "t": "evt", "seq": 48214, "threadId": "thr_…", "type": "turn.started", "v": 1, "payload": { … } }
```

One global counter rather than per-thread counters means a client tracks exactly one integer to describe everything it has seen. Since a client subscribes to a subset of threads, **gaps in the seq it observes are normal** and must not be treated as loss.

`v` is the event schema version — see [ADR 0004](../adr/0004-event-sourced-orchestration.md).

### Reconnect

The client reconnects and declares what it already has:

```jsonc
{ "t": "req", "id": "r1", "cmd": "session.resume",
  "payload": { "since": 48213, "threads": ["thr_a", "thr_b"] } }
```

The server responds one of two ways:

| Response | When | Client action |
| --- | --- | --- |
| `{ "mode": "replay", "through": 48260 }` followed by the gap's `evt` frames | `since` is within the retention window | Apply events, resume normally |
| `{ "mode": "snapshot_required" }` | `since` is older than retention, or unknown | Discard local projections, fetch fresh via `thread.snapshot` |

**The client never assumes it can resume.** `snapshot_required` is a routine response, not an error, and must be exercised in tests rather than discovered in production.

Retention is a bounded window of recent events kept ready for replay (the durable log is complete; retention governs only the fast replay path). Below the window, clients take a snapshot.

### Ordering guarantees

- Events for a given thread arrive in `seq` order
- A `res` for a command arrives **after** the events that command appended — so a client that sees `res` has already seen the resulting state
- No total-order guarantee is offered between `evt` frames and unrelated `res` frames

## Streaming and backpressure

Assistant token deltas are the highest-frequency traffic and get special handling.

**Deltas are ephemeral render hints, not durable truth.** The durable record is the committed turn content, appended when the turn completes. This distinction is what makes the rules below safe.

| Rule | Detail |
| --- | --- |
| **Coalesce before sending** | Buffer `assistant.delta` per thread and flush on a ~16ms tick — one frame per render frame, not one frame per token |
| **Coalesce before persisting** | Never write one row per token. Deltas accumulate in memory and are persisted with the committed turn |
| **Watch the send buffer** | Track `bufferedAmount`. Above a high-water mark, the connection enters catch-up mode |
| **Catch-up mode** | Collapse pending deltas for a thread into a single consolidated update and skip intermediate frames. The user sees text jump forward rather than stream smoothly — correct, just less pretty |
| **Never drop domain events** | Only deltas may be collapsed. `turn.completed`, `approval.requested`, `session.error` and friends are always delivered in order |
| **Slow client cannot stall an agent** | Provider I/O never blocks on socket writes. A client too slow to keep up is disconnected and resumes via the cursor above |

## Subscriptions

```jsonc
{ "t": "sub", "threads": ["thr_a", "thr_b"] }
```

Replaces the subscription set outright; it is not additive. The server pushes events only for subscribed threads, plus environment-level events (project list changes, provider detection) which every client receives.

Subscribing to a thread does not deliver its history — history comes from `thread.snapshot` or replay.

## Commands

Names are the contract surface; payloads are locked in `packages/contracts` at Phase 0.

| Command | Notes |
| --- | --- |
| `session.resume` | Reconnect with a cursor (above) |
| `project.create` / `project.list` | Directory-rooted workspaces |
| `thread.create` / `thread.snapshot` | Snapshot returns projection state plus its `seq` watermark |
| `turn.send` | Starts a turn; returns `turnId` |
| `turn.interrupt` | Takes an explicit `turnId` — never "the current turn" |
| `approval.respond` | Carries the approval id being answered |
| `provider.detect` | Refresh capability matrix |

Every command that acts on in-flight work names its target explicitly. There is no implicit "current" turn, session, or approval on the wire — that ambiguity is unresolvable when two clients are connected to the same thread.

## Multi-client

Several clients may attach to one environment and one thread simultaneously (desktop plus paired browser). All of them receive the same events. No client owns a thread, and none may assume it is the only writer — this is why interrupts and approvals carry explicit ids.

## Testing

Phase 0 suite (`bun test`):

- Handshake rejection for each of the eight concrete paths (host, origin missing/foreign, protocol, bearer-first, no token, query token, bad token)
- Resume inside retention → `replay`, and past retention / future cursor → `snapshot_required`
- Projection rebuild from the event log
- Interrupt → `stopping` via the mock-peer adapter fixture (no live CLI)

See `apps/server/src/*.test.ts` and `packages/adapters/src/mock.ts`.

## Related

- [Security](security.md) — handshake rules and rationale
- [Orchestration](orchestration.md) — where events come from
- [Performance](performance.md) — the budgets this protocol has to hit
- ADR [0004](../adr/0004-event-sourced-orchestration.md) — event log and versioning
