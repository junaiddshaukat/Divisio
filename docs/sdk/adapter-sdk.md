# Adapter SDK (Phase 4)

Divisio first-party and community adapters implement the same
`ProviderAdapter` interface from `@divisio/contracts`. Orchestration never
imports vendor CLIs directly.

## Install (workspace)

```ts
import type { ProviderAdapter } from "@divisio/contracts";
import {
  AdapterRegistry,
  STREAM_ADAPTER_TEMPLATE,
  loadCommunityAdapters,
} from "@divisio/adapters/sdk";
```

The `STREAM_ADAPTER_TEMPLATE` string is a copy-paste starter for stream-tier CLIs.

## Choose a tier

| Tier | Use when |
| --- | --- |
| **Structured** | Vendor JSON-RPC / app-server / ACP |
| **Stream** | NDJSON / stream-json CLI |
| **PTY** | Last resort interactive-only CLI |

Prefer the highest tier the CLI supports. Never fake `capabilities`.

## Checklist

1. Implement `detect`, `startSession(input, emit)`, `sendTurn`, `interruptTurn`, `stopSession`
2. Set `contractVersion` to `ADAPTER_CONTRACT_VERSION`
3. Map vendor lines → `ProviderRuntimeEvent`
4. Add golden NDJSON fixtures + normalizer tests
5. Export `createAdapter()` or `createAdapters()`
6. Document PATH / auth prerequisites in your README

## Capability honesty

If `approvals: true`, Divisio shows Approve/Deny. If your CLI cannot mediate, leave it `false` and document CLI-managed permissions.

## Loading community adapters

Trust boundary: Divisio only loads modules the operator opted into. Nothing is auto-downloaded.

| Source | How |
| --- | --- |
| Reference pack | `@divisio/community-adapters` (Gemini, Copilot, Antigravity) loaded at daemon boot as `source: "community"` |
| Env | `DIVISIO_ADAPTER_MODULES=./my-adapter.ts,@org/divisio-foo` |
| Config | `~/…/userdata/adapters.json` → `{ "modules": ["@org/divisio-foo"] }` |

```ts
export function createAdapter(): ProviderAdapter { … }
// or
export function createAdapters(): ProviderAdapter[] { … }
```

Contract mismatches fail at `register` (startup), not mid-turn. The Providers matrix labels community rows with `community · <tier>`.

Until packages are published to npm, keep adapters in the monorepo under `packages/community-adapters` (or your own workspace package) and point the loader at the package name.

## Promotion to first-party

Only promote when Divisio maintains CI smoke, fixtures, and docs. Prefer leaving P2+ providers as community forever.

## References

- [Adapter protocol](../architecture/adapter-protocol.md)
- [Adapter testkit](../architecture/adapter-testkit.md)
- [Providers](../specs/providers.md)
- ADR [0003-three-tier-adapters](../adr/0003-three-tier-adapters.md)
