# ADR 0005: Worktree isolation for parallel agents

## Status

Accepted

## Context

Parallel agents on one checkout corrupt each other’s edits. Git worktrees, sometimes combined with port injection, are the established isolation primitive for this problem.

## Decision

- Phase 1: single checkout + turn **checkpoints** (hidden git refs) for diff/restore
- Phase 2: **git worktree per parallel lane** as the default isolation model
- Support optional project setup/run scripts and unique preview ports when we reach parallel delivery
- Do not require containers for MVP isolation

## Consequences

- Users need git repos for full parallel value
- Worktree lifecycle (create, open PR, archive) becomes core UX
- Adapters should honor `cwd` / worktree paths (`worktreeAware` capability)
- Non-git folders may be limited to single-lane mode initially

See [roadmap](../roadmap.md) Phase 2.
