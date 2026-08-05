# MVP specification

Covers **Phase 0 (Spike)** and **Phase 1 (Core)**. Later phases have exit criteria in [roadmap](../roadmap.md).

## In scope

### Phase 0

- Local Node daemon with WebSocket API
- Minimal React web client
- One working provider adapter (Codex **or** Claude — implement fully, not both half-done)
- Create project (directory path), create thread, send turn, stream transcript
- Interrupt turn
- Persist enough state to survive daemon restart
- Health endpoint / basic logging

### Phase 1

- P0 adapters: Claude Code, Codex, Cursor
- Permission modes: supervised + full access
- Turn checkpoints + turn diff in UI
- Provider capability matrix visible in UI
- Documented `ProviderAdapter` contracts matching code

## Out of scope (MVP)

- Tauri/desktop packaging, mobile (desktop size budget applies in Phase 3)
- Worktrees / parallel board / one-click PR
- Provider handoff
- Remote pairing / LAN
- Community adapter loading
- Quota rotation / multi-account
- MCP server/client platform features
- Vendoring another product's application code

## UX direction (even in MVP web)

- Implement against [design system](../design/README.md) — especially [tokens](../design/tokens.md), [layout](../design/layout.md), [components](../design/components.md)
- Light + dark both required for UI acceptance (see [theme-modes](../design/theme-modes.md))
- No decorative stream animations; follow [motion](../design/motion.md) and [performance](../architecture/performance.md)

## Acceptance criteria

### Phase 0

| ID | Criterion |
| --- | --- |
| P0-1 | `pnpm`/`bun` (TBD at code start) installs and starts server + web |
| P0-2 | User pairs or opens local UI and sees empty project list |
| P0-3 | User adds a project rooted at an existing git repo path |
| P0-4 | User starts a session with the chosen P0 adapter and sends a prompt |
| P0-5 | Assistant tokens/events stream into the transcript without full-page refresh |
| P0-6 | User interrupts; status returns to ready; no zombie runaway without UI affordance |
| P0-7 | Restart daemon; prior thread messages still appear |
| P0-8 | All app and server code in the repo is ours or a declared OSS dependency |

### Phase 1

| ID | Criterion |
| --- | --- |
| P1-1 | User can select Claude, Codex, or Cursor when starting a thread (given CLI installed + authed) |
| P1-2 | Capability matrix shows accurate flags per provider |
| P1-3 | Supervised mode prompts on destructive tool use; deny blocks the tool |
| P1-4 | Full-access mode does not prompt for the same class of tools |
| P1-5 | After a turn, UI can show diff vs checkpoint |
| P1-6 | Adapter interface in `packages/contracts` is the source of truth for new providers |

## UX bar (MVP)

- Fast transcript scrolling; no decorative GPU-heavy animations
- Clear connection/session status (connecting, running, awaiting approval, error)
- Errors are actionable (e.g. “Codex not on PATH” / “run `claude auth login`”)

## Definition of done for MVP

Phase 0 and Phase 1 exit criteria checklists in [roadmap](../roadmap.md) are complete, and this acceptance table is satisfied.
