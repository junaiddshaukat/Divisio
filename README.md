# Divisio

**Working name — brand TBD.** Local-first command center for the coding agents you already pay for.

Divisio is not an AI model and does not sell tokens. It is a control surface: one polished workspace that drives Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, and eventually 20+ CLI agents — with parallel worktrees, diffs, PRs, and provider handoff.

## Pitch

Serious agentic work is scattered across terminals, vendor apps, and tabs. Divisio keeps chat, terminals, previews, git, and delivery in one place while each provider keeps its own auth and subscription.

## Product bars

- **Feel:** thread switch under 100ms, first streamed token under 100ms, interrupt acknowledged under 150ms
- **Size:** desktop install **&lt; 150 MB**
- **Look:** dense three-pane command center — projects and threads, transcript and composer, working surfaces

## Non-goals

- Not an LLM provider or API proxy for your keys
- Not shipping mobile or twenty adapters in the first release
- Not Electron-by-default (Tauri thin shell — see ADR 0006)

## Docs (source of truth)

| Doc | Purpose |
| --- | --- |
| [Vision](docs/vision.md) | Problem, audience, differentiation |
| [Roadmap](docs/roadmap.md) | Phases 0–4 with exit criteria |
| [Architecture overview](docs/architecture/overview.md) | System shape and package layout |
| [Adapter protocol](docs/architecture/adapter-protocol.md) | Three-tier provider adapters |
| [Orchestration](docs/architecture/orchestration.md) | Commands, events, projections |
| [WS protocol](docs/architecture/ws-protocol.md) | Handshake, framing, resume |
| [Performance](docs/architecture/performance.md) | Latency and size budgets |
| [Design system](docs/design/README.md) | Tokens, type, layout |
| [Design tokens](docs/design/tokens.md) | Light + dark color tokens |
| [MVP spec](docs/specs/mvp.md) | Phase 0–1 acceptance criteria |
| [Glossary](docs/specs/glossary.md) | Shared vocabulary |
| [ADRs](docs/adr/) | Locked decisions |

## Status

**Phase 0 complete.** Daemon, event log, WebSocket protocol, Claude Code adapter, and web UI all work end to end. Phase 1 (three adapters, permissions, checkpoints) is next — see [roadmap](docs/roadmap.md).

## Run it

Requires [Bun](https://bun.com) 1.3.1+ and at least one authenticated agent CLI.

```bash
bun install
bun run dev:server    # daemon on 127.0.0.1:4577
bun run dev:web       # UI on localhost:5173
```

The daemon prints the path to its auth token on startup. Paste that token into the UI once — auth is required even on loopback, because localhost is not a trust boundary ([why](docs/architecture/security.md)).

| Path | What it is |
| --- | --- |
| `apps/server` | Bun daemon: event log, WS API, adapter host |
| `apps/web` | React UI |
| `packages/contracts` | Events, commands, wire format, adapter interface |
| `packages/adapters` | Provider adapters |
| `packages/shared` | Branding, paths, ids, logging |

All naming lives in [`packages/shared/src/brand.ts`](packages/shared/src/brand.ts) — renaming the product edits one file.

## License

[MIT](LICENSE)
