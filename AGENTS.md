# AGENTS.md

Guidance for coding agents and humans working in this repository.

## What this project is

**Divisio** (working name) is a local-first command center for third-party coding agent CLIs. It is not an LLM provider. Read [docs/vision.md](docs/vision.md) and [docs/specs/glossary.md](docs/specs/glossary.md) before changing behavior.

## Hard rules

1. **Own the implementation.** Every line in this repo is ours or a well-known OSS dependency. Do not vendor another product's application tree, stylesheet, or UI package. See [ADR 0001](docs/adr/0001-own-the-implementation.md).
2. **Docs are the source of truth until code exists.** Prefer updating specs/ADRs when changing intent. Do not invent conflicting architecture in chat-only decisions.
3. **Complexity at the adapter boundary.** Orchestration stays provider-agnostic. UI does not speak vendor protocols.
4. **Smallest correct change.** No drive-by refactors, no unsolicited markdown spam, no new deps without need.
5. **Vocabulary.** Use glossary terms: environment, project, thread, turn, provider, adapter, worktree, checkpoint, handoff.
6. **Performance + size.** Meet [performance](docs/architecture/performance.md) targets; desktop artifact &lt; 150 MB ([ADR 0006](docs/adr/0006-size-budget-tauri.md)).
7. **UI craft.** Follow the [design system](docs/design/README.md) pack (`tokens`, `typography`, `layout`, `components`, `motion`). Use `.agents/skills/emil-design-eng` when reviewing UI.

## Current phase

**Roadmap phases 0–4 are complete in-repo.** Launch work is product proof (live smoke on real CLIs), a signed desktop build, and docs that match the app. Follow [docs/roadmap.md](docs/roadmap.md). Do not treat AGENTS.md as a phase tracker if it disagrees with the roadmap.

## Runtime rules

- **Bun only** ([ADR 0008](docs/adr/0008-bun-runtime.md)). `bun:sqlite`, not `better-sqlite3` — the latter hard-panics the process under Bun
- Bun-specific APIs stay in `packages/shared` and the storage layer; contracts, orchestration, and adapters stay portable
- Every event carries `type` and `v`; a version bump ships its upcaster in the same commit ([ADR 0004](docs/adr/0004-event-sourced-orchestration.md))
- Product naming lives only in `packages/shared/src/brand.ts`

## Layout

- `apps/server` — Bun daemon
- `apps/web` — React UI
- `packages/contracts` — schemas only
- `packages/adapters` — provider adapters
- `packages/shared` — shared runtime utils

Do not run repo-wide full checks unless asked. Prefer targeted tests for the behavior you changed. Never kill processes by name/pattern; track PIDs you spawned.

## Provider work

- Read [adapter protocol](docs/architecture/adapter-protocol.md) and [providers](docs/specs/providers.md)
- Declare capabilities honestly
- Map vendor events to normalized runtime events

## Security

- Local-first; no key proxy
- Respect permission modes — [permissions](docs/specs/permissions.md)
- Never commit secrets or userdata databases

## Commits and PRs

Only commit when the human asks. One concern per PR. Conventional, plain-language titles.
