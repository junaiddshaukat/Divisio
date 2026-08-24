# Divisio

Local-first command center for the coding agents you already pay for.

Divisio is not an AI model and does not sell tokens. It is a control surface: one workspace that drives the CLIs you already run — Claude Code, Codex, Cursor, Grok, Qwen, OpenCode, Gemini, Copilot, Antigravity, plus OpenAI-compatible endpoints you add — with parallel git worktrees, diffs, PRs, terminals, and cross-provider handoff. Each provider keeps its own login.

## Pitch

Serious agentic work is scattered across terminals, vendor apps, and tabs. Divisio keeps chat, terminals, previews, git, and delivery in one place while each provider keeps its own auth and subscription.

## What is in the repo

Roadmap phases 0–4 are implemented: daemon, P0–P2 adapters, lanes/board, handoff, desktop shell, pairing, adapter SDK. Launch is still a **human smoke gate + a signed desktop build**, not more architecture. See [roadmap](docs/roadmap.md).

## Product bars

- **Feel:** thread switch under 100ms, first streamed token under 100ms, interrupt acknowledged under 150ms
- **Size:** packaged macOS app measured at **66 MB** (budget 150 MB; daemon is bundled)
- **Look:** dense three-pane command center — projects and threads, transcript and composer, working surfaces

## Non-goals

- Not an LLM provider or API proxy for vendor keys
- Not mobile, not a Divisio cloud, not selling model access
- Not Electron (Tauri thin shell — [ADR 0006](docs/adr/0006-size-budget-tauri.md))

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
| [MVP spec](docs/specs/mvp.md) | Phase 0–1 acceptance (historical) |
| [Worktrees](docs/specs/worktrees.md) | Parallel lanes |
| [Benchmarks](docs/operations/benchmarks.md) | Measured size and latency |
| [Glossary](docs/specs/glossary.md) | Shared vocabulary |
| [ADRs](docs/adr/) | Locked decisions |

## Run it

Requires [Bun](https://bun.com) 1.3.5+ to develop from source, [Rust](https://rustup.rs) for the desktop shell, and at least one authenticated agent CLI.

### Desktop app (recommended)

Opens a native window, starts the bundled daemon, and connects automatically — no token paste.

```bash
bun install
bun run dev:desktop
```

First launch compiles the Tauri shell (a few minutes). Later launches are fast.

**Packaged app:** the daemon is compiled into the `.app`. End users do **not** need Bun on PATH. Bun is only required to *build* from this repo.

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
| `packages/adapters` | First-party adapters + SDK |
| `packages/community-adapters` | Gemini, Copilot, Antigravity |
| `packages/shared` | Branding, paths, ids, logging |

All naming lives in [`packages/shared/src/brand.ts`](packages/shared/src/brand.ts) — renaming the product edits one file.

## License

[MIT](LICENSE)
