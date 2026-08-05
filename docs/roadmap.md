# Roadmap

Phases are sequential. Do not start the next phase until exit criteria for the current one pass. Brand name may change; architecture should not thrash.

## Phase 0 — Spike

**Goal:** Prove daemon ↔ one provider ↔ minimal chat end-to-end with our own code.

| Deliverable | Notes |
| --- | --- |
| `apps/server` skeleton | WebSocket API, health, pairing token stub |
| `packages/contracts` | Minimal command/event schemas |
| One adapter | Prefer Codex app-server *or* Claude stream — pick one and finish it |
| `apps/web` minimal UI | Project picker stub, thread, streaming transcript |
| Local SQLite | Persist threads/messages enough to survive restart |

**Exit criteria — all met**

- [x] Start daemon, open web UI, send a turn, see streamed output
- [x] Interrupt a turn
- [x] Restart daemon; thread history still loads
- [x] All UI and server code is ours or a declared OSS dependency

Also delivered beyond the original bar: the five handshake checks with all eight rejection paths verified, reconnect gap replay plus `snapshot_required`, delta coalescing with backpressure, a `stopping` session state, and projections proven to rebuild identically from the log.

**Committed tests:** `bun test` covers handshake (8 paths), resume replay vs `snapshot_required`, projection rebuild, interrupt → `stopping`, and a mock-peer adapter fixture (no live Claude).

## Phase 1 — Core

**Goal:** Three first-party adapters, permissions, projects, checkpoints.

| Deliverable | Notes |
| --- | --- |
| Adapters | Claude Code, Codex, Cursor (P0 — see [providers](specs/providers.md)) |
| Permissions | Supervised vs full-access modes — [permissions](specs/permissions.md) |
| Projects | Directory-rooted workspaces |
| Checkpoints | Hidden git ref (or equivalent) per turn for diff/restore |
| Capability matrix UI | Show what each provider supports |

**Exit criteria**

- [ ] Switch provider on a project without restarting the app
- [ ] Approval prompts work for file/shell tools in supervised mode
- [ ] Diff a turn against pre-turn checkpoint
- [ ] Documented adapter interface matches implementation

## Phase 2 — Parallel

**Goal:** Worktree isolation and delivery loop.

| Deliverable | Notes |
| --- | --- |
| Worktrees | One isolated tree/branch per parallel lane |
| Session board | See running / waiting / done lanes |
| Diff review | Aggregate changes; stage/commit helpers |
| Open PR | `gh` or equivalent from the UI |
| Setup/run scripts | Optional project config for install + preview ports |

**Exit criteria**

- [ ] Two agents on one repo in separate worktrees without file clobber
- [ ] Create PR from a finished lane
- [ ] Archive/cleanup worktree from the UI

## Phase 3 — Handoff + remote

**Goal:** Cross-provider handoff and remote-ready pairing.

| Deliverable | Notes |
| --- | --- |
| Provider handoff | Continue thread context on another adapter |
| Desktop shell | Tauri wraps local web + daemon sidecar; artifact &lt; 150 MB |
| Pairing / LAN | Token-gated remote client over local network or Tailscale |
| Terminals panel | Keep live processes visible beside chat |

**Exit criteria**

- [ ] Hand off Claude → Codex (or reverse) with usable continued context
- [ ] Pair a second browser on the LAN with a one-time token
- [ ] Desktop app starts daemon without separate terminal
- [ ] Packaged desktop artifact measures under 150 MB
- [ ] Perf smoke: thread switch and stream paint meet [performance](architecture/performance.md) targets

## Phase 4 — Ecosystem

**Goal:** Public adapter SDK and community registry path.

| Deliverable | Notes |
| --- | --- |
| Adapter SDK docs | Templates for Structured / Stream / PTY tiers |
| PTY template | Fallback path for unknown interactive CLIs |
| Registry docs | How to publish a community adapter |
| Quota-ready hooks | Multi-profile / limit signals (implementation may be partial) |

**Exit criteria**

- [ ] External contributor can add an adapter against contracts without editing orchestration core
- [ ] At least one P1 provider beyond P0 is first-party or community
- [ ] Capability matrix covers community adapters

## Out of roadmap (for now)

- Mobile apps
- Cloud-hosted Divisio proxy
- Selling model access
- Full 20+ first-party adapters before the SDK exists
