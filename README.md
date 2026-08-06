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
| [Worktrees](docs/specs/worktrees.md) | Phase 2 parallel lanes |
| [Benchmarks](docs/operations/benchmarks.md) | Measured size and latency |
| [Glossary](docs/specs/glossary.md) | Shared vocabulary |
| [ADRs](docs/adr/) | Locked decisions |

## Status

**Phase 1 Core MVP complete** for the web+daemon path: three P0 adapters (Claude, Codex, Cursor), supervised/full-access permissions (honest — only mediating adapters), turn checkpoints + diff, and a provider capability matrix. Tauri desktop packaging is still Phase 3. See [roadmap](docs/roadmap.md).

## Run it

Requires [Bun](https://bun.com) 1.3.1+, [Rust](https://rustup.rs) (desktop only), and at least one authenticated agent CLI.

### Desktop app (recommended)

Opens a native window, starts the daemon for you, and connects automatically — no token paste.

```bash
bun install
bun run dev:desktop
```

First launch compiles the Tauri shell (a few minutes). Later launches are fast. **Bun must be on your PATH** so the shell can spawn the daemon.

Release build (`.app` / installer):

```bash
bun run build:desktop
```

Artifacts land under `apps/desktop/src-tauri/target/release/bundle/`.

### Web + daemon (dev)

```bash
bun run dev:server    # daemon on 127.0.0.1:4577
bun run dev:web       # UI on localhost:5173
```

Paste the token from `~/.divisio/userdata/auth-token` once (browsers cannot read that file). Auth is required even on loopback ([why](docs/architecture/security.md)).

| Path | What it is |
| --- | --- |
| `apps/desktop` | Tauri shell — window + daemon supervisor |
| `apps/server` | Bun daemon: event log, WS API, adapter host |
| `apps/web` | React UI (used by web and desktop) |
| `packages/contracts` | Events, commands, wire format, adapter interface |
| `packages/adapters` | Provider adapters |
| `packages/shared` | Branding, paths, ids, logging |

All naming lives in [`packages/shared/src/brand.ts`](packages/shared/src/brand.ts) — renaming the product edits one file.

## License

[MIT](LICENSE)
