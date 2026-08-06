# Adapter testkit

Vendor CLIs change constantly. Adapters must be testable **without** a live binary.

## Pieces

| Piece | Role |
| --- | --- |
| [`MockPeerAdapter`](../../packages/adapters/src/mock.ts) | In-process peer for orchestration / interrupt tests |
| [`testkit/replay.ts`](../../packages/adapters/src/testkit/replay.ts) | Replay NDJSON fixtures through a normalizer |
| [`claude/normalize.ts`](../../packages/adapters/src/claude/normalize.ts) | Pure Claude stream-json → `ProviderRuntimeEvent` |
| [`codex/normalize.ts`](../../packages/adapters/src/codex/normalize.ts) | Pure Codex app-server notifications → `ProviderRuntimeEvent` |
| [`cursor/normalize.ts`](../../packages/adapters/src/cursor/normalize.ts) | Pure Cursor stream-json → `ProviderRuntimeEvent` |
| [`jsonrpc/stdio.ts`](../../packages/adapters/src/jsonrpc/stdio.ts) | NDJSON JSON-RPC client (Codex omits `"jsonrpc":"2.0"`) |
| [`fixtures/claude/*.ndjson`](../../packages/adapters/fixtures/claude/) | Golden Claude stream-json lines |
| [`fixtures/codex/*.ndjson`](../../packages/adapters/fixtures/codex/) | Golden Codex notification frames (`method` + `params`) |
| [`fixtures/cursor/*.ndjson`](../../packages/adapters/fixtures/cursor/) | Golden Cursor stream-json lines |

## Adding a fixture

1. Capture a real CLI stream (or hand-author NDJSON matching the vendor shape)
2. Drop it under `packages/adapters/fixtures/<provider>/`
3. Assert normalized events in `*.test.ts` — never spawn the CLI in CI

## Adding a provider normalizer

1. Extract parse logic into a pure `normalizeX(msg, turnId, state)` module
2. Keep process I/O in the adapter class
3. Register golden fixtures before merging the adapter

Fixture-based ACP peer tests — not live processes.
