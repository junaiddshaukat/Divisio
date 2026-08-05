# Adapter testkit

Vendor CLIs change constantly. Adapters must be testable **without** a live binary.

## Pieces

| Piece | Role |
| --- | --- |
| [`MockPeerAdapter`](../../packages/adapters/src/mock.ts) | In-process peer for orchestration / interrupt tests |
| [`testkit/replay.ts`](../../packages/adapters/src/testkit/replay.ts) | Replay NDJSON fixtures through a normalizer |
| [`claude/normalize.ts`](../../packages/adapters/src/claude/normalize.ts) | Pure Claude stream-json → `ProviderRuntimeEvent` |
| [`fixtures/claude/*.ndjson`](../../packages/adapters/fixtures/claude/) | Golden recorded vendor lines |

## Adding a fixture

1. Capture a real CLI stream (or hand-author NDJSON matching the vendor shape)
2. Drop it under `packages/adapters/fixtures/<provider>/`
3. Assert normalized events in `*.test.ts` — never spawn the CLI in CI

## Adding a provider normalizer

1. Extract parse logic into a pure `normalizeX(msg, turnId, state)` module
2. Keep process I/O in the adapter class
3. Register golden fixtures before merging the adapter

Pattern inspired by T3 Code's mock ACP peer tests — fixtures, not live processes.
