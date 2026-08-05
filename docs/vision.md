# Vision

## Problem

Developers already pay for multiple coding agents — Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity, and more. Each ships its own CLI or GUI. Parallel work means juggling terminals, losing context when switching models, and fighting git conflicts when two agents touch the same checkout.

The missing layer is not another model. It is a **command center**: local, fast, provider-agnostic, and honest about what each agent can do.

## Who it is for

- Individual developers and small teams who run more than one coding agent daily
- People who want BYO subscriptions (no new AI bill, no key proxy)
- Builders who need parallel lanes (features/bugs) without stomping `main`
- Contributors who want to add a new CLI via a public adapter SDK

## Product thesis

One local workspace that holds session chat, worktree-parallel delivery, provider handoff, and local-first privacy together — on top of a public adapter protocol built for 20+ CLIs.

Working name: **Divisio** (brand TBD).

## Differentiators

1. **Adapter SDK as day-one product** — community can add agents without forking the app
2. **Capability matrix** — UI tells the truth per provider (resume, approvals, models, handoff)
3. **Cross-agent handoff** — move a thread to another provider with continued context
4. **Quota-ready accounts** — design for multi-profile / limit-aware routing later
5. **Latency as a release gate** — start, switch, stream, and interrupt budgets block a release ([performance](architecture/performance.md))
6. **Lean desktop** — packaged app **under 150 MB** via Tauri ([ADR 0006](adr/0006-size-budget-tauri.md))
7. **Dense command-center UI** — built for people who keep several agents running at once ([design](design/README.md))

## Principles

1. Local-first: chats, projects, and history live on the user’s machine
2. Direct-to-provider: Divisio does not proxy API keys or store prompts in our cloud
3. Complexity at the adapter boundary; orchestration stays pure; UI stays focused
4. Correctness over convenience under reconnects, partial streams, and session restarts
5. Own our implementation end to end

## Success looks like

- A developer runs Claude and Codex in parallel worktrees from one window
- Switching or handing off providers does not require rebuilding context by hand
- A third-party adapter for a new CLI can ship against documented contracts
- Diff → review → PR without leaving the workspace
- Everyday actions land within the [performance](architecture/performance.md) budgets; desktop install stays under 150 MB
- The workspace reads as obvious to anyone who already runs agents daily
