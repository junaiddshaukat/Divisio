# ADR 0003: Three-tier provider adapters

## Status

Accepted

## Context

Coding agent CLIs expose inconsistent interfaces: JSON-RPC app-servers, NDJSON streams, or only interactive terminals. Supporting 20+ agents requires a protocol strategy, not one-off `if (provider)` branches in orchestration.

## Decision

Adopt a **three-tier adapter protocol**:

1. Structured (JSON-RPC / ACP / app-server)
2. Stream (NDJSON / hooks)
3. PTY fallback

All adapters implement one `ProviderAdapter` shape, declare **capabilities**, and emit normalized `ProviderRuntimeEvent`s. Orchestration and UI never speak vendor protocols directly.

## Consequences

- New providers are mostly adapter work
- Capability matrix keeps UX honest
- PTY tier will be lossy; document limitations per adapter
- Public SDK in Phase 4 builds on this decision

See [adapter-protocol](../architecture/adapter-protocol.md).
