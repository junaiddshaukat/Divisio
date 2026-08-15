# Adapter protocol

Adapters are the **only** place vendor CLI differences are allowed to live. Orchestration and UI speak a single normalized event model.

## Three tiers

| Tier | Transport | When to use | Examples |
| --- | --- | --- | --- |
| **Structured** | JSON-RPC / ACP / app-server over stdio | Vendor exposes a stable machine protocol | Codex `app-server`, ACP-capable agents |
| **Stream** | NDJSON / event stream / hooks on a CLI | Structured enough for turns and tools, not full RPC | Claude Code stream-json, Cursor agent streams |
| **PTY** | Pseudo-terminal | Last resort for interactive CLIs | Unknown tools, weak machine APIs |

Prefer the highest tier available. A provider may upgrade tiers over time without changing orchestration contracts.

## Capability flags

Each adapter declares what it supports. The UI uses this matrix instead of guessing.

| Capability | Meaning |
| --- | --- |
| `sessionResume` | Can resume a vendor-native session id |
| `interruptTurn` | Can cancel an in-flight turn |
| `modelSwitch` | In-session vs requires new session |
| `approvals` | Emits permission requests Divisio can mediate |
| `handoffExport` | Can produce a continuation packet for another provider |
| `worktreeAware` | Safe/expected to run with `cwd` set to a worktree |
| `usageSignals` | Maps vendor token counts onto `usage.reported` when the CLI actually emits them — never invented |

Optional `listModels()` returns a `ModelCatalog`. `live` means the adapter read the vendor CLI’s own settings or cache (side-effect-free). `none` means the UI may fall back to curated aliases. Secrets in vendor config files must never appear in the catalog.

Unknown = unsupported. Never fake a capability.

When an adapter reports a vendor-native session id, the orchestrator writes `thread.vendor_session_set` and passes it as `resumeId` on the next `startSession` — only if `sessionResume` is true. Each live start also writes `session.resume_outcome` (`resumed` | `cold` | `unsupported` | `failed`) so a CLI that ignored `--resume` is visible on the log instead of looking continuous. Divisio’s transcript is independent: a CLI that cannot resume starts a fresh vendor conversation after a restart, and the UI says so.

## Interface sketch

Names are illustrative; Phase 0 locks types in `packages/contracts`.

```ts
type ProviderKind = string; // e.g. "codex" | "claude" | "cursor" | ...

interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly tier: "structured" | "stream" | "pty";
  readonly capabilities: AdapterCapabilities;

  detect(): Promise<DetectResult>; // binary on PATH, auth hint
  listModels?(): Promise<ModelCatalog>; // optional; vendor catalog, no secrets
  startSession(input: StartSessionInput): Promise<SessionHandle>;
  sendTurn(session: SessionHandle, turn: SendTurnInput): Promise<void>;
  interruptTurn(session: SessionHandle): Promise<void>;
  respondToApproval(session: SessionHandle, response: ApprovalResponse): Promise<void>;
  stopSession(session: SessionHandle): Promise<void>;

  /** Normalized runtime events → orchestration via callback or async iterable */
  subscribe(session: SessionHandle, emit: (event: ProviderRuntimeEvent) => void): Unsubscribe;
}
```

Normalized `ProviderRuntimeEvent` examples: `assistant.delta`, `tool.started`, `tool.finished`, `approval.requested`, `turn.completed`, `usage.reported`, `session.error`.

## Registry

- First-party adapters ship in-repo under `packages/adapters`
- Community adapters (Phase 4) load against the same interface and declare capabilities
- Orchestration never branches on `kind` except for display metadata

See [adapter-testkit.md](adapter-testkit.md) for golden fixtures and normalizer replay.

## First-party vs community

| Class | Expectation |
| --- | --- |
| First-party (P0/P1) | Maintained with the app; CI smoke where possible |
| Community | Documented SDK; versioned against contracts; capability honesty required |

## Adding a provider

1. Choose the best tier the CLI supports
2. Implement `ProviderAdapter` + map vendor events → `ProviderRuntimeEvent`
3. Register with the adapter registry
4. Add capability matrix entries and UI provider label
5. Document detect/auth prerequisites in [providers](../specs/providers.md)

See ADR [0003-three-tier-adapters](../adr/0003-three-tier-adapters.md).
