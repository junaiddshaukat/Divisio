# Worktrees and parallel lanes

Phase 2. Implements [ADR 0005](../adr/0005-worktree-isolation.md).

Running two agents in one checkout corrupts both. Git worktrees solve the *file* isolation cleanly — `git worktree add` is a few hundred milliseconds and shares the object store. That part is easy.

The hard part is everything a worktree **does not** bring with it. A fresh worktree contains exactly the tracked files at a commit. It has no `node_modules`, no `.env`, no `.claude/settings.local.json`, no MCP server config, and no build cache. An agent dropped into it cannot install, run, or test anything. Getting that right is the whole of this spec.

Every git behaviour this spec relies on was verified rather than assumed: refs written from a lane are visible in the primary checkout, git refuses the same branch in two worktrees, `worktree remove` refuses a dirty tree, and `worktree prune` reconciles an externally deleted lane.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Lane** | One isolated unit of parallel work: a worktree, a branch, and the threads running against it |
| **Primary checkout** | The directory the user added as the project. Never used as a lane |
| **Lane root** | The worktree directory an agent runs in |

A project has one primary checkout and zero or more lanes. Threads bind to a lane; a thread without a lane runs in the primary checkout, which is the Phase 1 behaviour and stays supported.

## Where lanes live on disk

**Outside the repository**, under the daemon home:

```
~/.divisio/worktrees/<projectId>/<laneId>/
```

The alternative — nesting under the primary checkout as `.divisio/worktrees/` — fails in ways that are hard to undo:

- File watchers and dev servers in the primary checkout recurse into every lane, so one agent's edits trigger another lane's rebuilds
- An agent asked to "search the repo" reads the other lanes' code and treats it as project source. It then edits against a version of the file that another agent is concurrently rewriting
- `rg`/`find` results become quadratic in lane count
- One stray `git add -A` in the primary checkout stages the entire lane tree

The cost of living outside is that tooling using paths relative to a repo parent (a monorepo sibling, a shared `.env` two directories up) will not resolve. That is a real limitation and is documented rather than worked around, because the alternative is worse.

## Branches

| Rule | Value |
| --- | --- |
| Branch name | `divisio/<slug>` where slug derives from the lane title |
| Base | The project's current `HEAD` at lane creation, recorded in the lane event |
| Collision | Append `-2`, `-3`; never silently reuse an existing branch |

Git refuses to check out one branch in two worktrees simultaneously, and that refusal is correct — do not defeat it with `--force`. Surface it as "that branch is already open in another lane".

## Carrying over what git does not track

This is the core problem. A lane needs files that are deliberately untracked.

### The rule: copy, never symlink

Untracked files are **copied** into the lane at creation. They are never symlinked back to the primary checkout.

A symlink means an agent writing `.env` — or anything reached through a linked directory — writes *through* to the user's primary checkout. That is precisely the cross-contamination worktrees exist to prevent, and it is worse than no isolation because the user believes they are isolated.

Copying costs disk and drifts from the original. Both are acceptable; silent corruption of the user's working tree is not.

### What gets copied

A project-level config declares it, with defaults that cover the common case:

```jsonc
// .divisio/project.json in the primary checkout, committed or not
{
  "lane": {
    "carryOver": [".env", ".env.local", ".claude/settings.local.json", ".mcp.json"],
    "setup": "bun install",
    "run": "bun run dev",
    "portEnv": ["PORT", "VITE_PORT"]
  }
}
```

Defaults when absent: carry over `.env*` (excluding `.env.example`), plus agent-local config directories for the selected provider. Never carry over `node_modules`, `.git`, build outputs, or anything above a size threshold.

**Secrets are being copied.** Lane roots inherit the `0700` treatment of the daemon home, and `divisio lane remove` deletes the directory rather than orphaning credentials in a temp path. Copied secrets never enter event payloads or logs.

### Dependencies

`node_modules` is **not copied**. It contains absolute paths, platform-specific binaries, and symlink farms that break when relocated — a copied tree fails in ways that look like application bugs rather than setup bugs.

Instead the declared `setup` command runs once at lane creation, streamed into the UI as lane status `preparing`. Modern package managers have a global content-addressed store, so a second install of the same lockfile is mostly hardlinks and is fast. That is the mechanism this depends on, and it is worth stating plainly: on a package manager without a shared store, lane creation is slow and disk-hungry.

Lane creation therefore has a **visible preparing phase**. It is not instant, and pretending otherwise in the UI would make the first lane feel broken.

## Ports

Two lanes running dev servers both want port 3000. The daemon allocates a free port per lane at creation, records it on the lane, and injects it via the declared `portEnv` names when running `setup` or `run`.

Allocation binds the port to confirm it is actually free rather than assuming, and holds the reservation for the lane's lifetime. A lane's port is stable across restarts so bookmarked preview URLs keep working.

## Provider sessions in a lane

- The adapter's `cwd` is the lane root. Adapters already declare `worktreeAware`; a lane refuses to start on an adapter that does not
- Each lane's session is a separate provider process with its own MCP servers. **N lanes means N sets of MCP processes** — this is the real resource cost of parallelism, not the worktrees themselves
- A concurrency ceiling applies (default 4, configurable). Beyond it, lane creation queues rather than thrashing the machine. Unbounded parallelism is how this category earns a reputation for melting laptops

## Checkpoints inside lanes

Checkpoint refs work unchanged. Git refs live in the shared common directory, so `refs/divisio/checkpoints/...` written from a lane is visible from the primary checkout and survives lane removal. Diff and restore need no lane-specific handling.

## Lifecycle

```
created → preparing → ready → running ⇄ ready → reviewing → archived
                 ↘ error
```

| Transition | Behaviour |
| --- | --- |
| **Create** | Allocate id, port, branch; `git worktree add`; copy carry-over files; run setup |
| **Ready** | Threads may bind and send turns |
| **Review** | Aggregate diff of the lane branch against its base |
| **Open PR** | `gh pr create` when available; otherwise push and surface the compare URL. Never a hard dependency on `gh` |
| **Archive** | Remove the worktree, optionally delete the branch, free the port |

### Removal must not destroy work

`git worktree remove` refuses on a dirty tree. Keep that refusal. Removal with uncommitted changes requires explicit confirmation naming what will be lost, and takes a final checkpoint ref first so the work is recoverable even after the directory is gone.

Orphaned worktrees — directory deleted outside the app, machine rebooted mid-create — are reconciled with `git worktree prune` on project open, and lanes whose roots no longer exist are marked `archived` rather than left claiming to be ready.

## Conflicts between lanes

Worktrees isolate files, not intent. Two lanes editing the same function will merge-conflict, and that is normal and correct — it surfaces at review or PR time, exactly as it would between two humans.

What Divisio adds is early visibility: the session board flags when two active lanes have touched the same paths, so the collision is known before both are finished. It does not attempt automatic resolution.

## Events

New event types, all at `v: 1`, following the [ADR 0004](../adr/0004-event-sourced-orchestration.md) rules:

| Event | Payload |
| --- | --- |
| `lane.created` | `laneId, projectId, title, branch, baseSha, root, port` |
| `lane.status` | `laneId, status, detail?` |
| `lane.setup_output` | `laneId, stream, text` — setup progress, coalesced like assistant deltas |
| `lane.archived` | `laneId, branchDeleted, hadUncommittedChanges` |

`thread.created` gains an **optional** `laneId`. Optional means additive, so no version bump and no upcaster — threads without a lane keep meaning exactly what they mean today.

## Commands

| Command | Notes |
| --- | --- |
| `lane.create` | `{ projectId, title, base? }` — returns after the worktree exists, with setup still streaming |
| `lane.list` | Board data |
| `lane.archive` | `{ laneId, deleteBranch, force }` — `force` required when dirty |
| `lane.diff` | Lane branch against its recorded base |
| `lane.openPr` | `{ laneId, title, body, commitMessage? }` — `commitMessage` is required only when the lane is dirty; the daemon never commits unasked |

## Non-git projects

Single-lane only. Lane creation returns a clear reason rather than a generic failure, matching how checkpoints already report `skipped`. Chat still works — the Phase 1 behaviour is unchanged.

## Acceptance criteria

| ID | Criterion |
| --- | --- |
| W-1 | Two agents run in separate lanes on one repo with no file interference |
| W-2 | Lane creation copies declared carry-over files and never symlinks into the primary checkout |
| W-3 | `node_modules` is produced by the setup command, not copied |
| W-4 | Two lanes running dev servers get distinct ports, stable across daemon restart |
| W-5 | Archiving a dirty lane requires explicit confirmation and leaves a recoverable checkpoint |
| W-6 | A lane whose directory was deleted externally reconciles to `archived` on project open |
| W-7 | Checkpoint diff works identically inside a lane and in the primary checkout |
| W-8 | Lane creation beyond the concurrency ceiling queues instead of spawning |
| W-9 | A PR opens from a finished lane without `gh` being mandatory |
| W-10 | A dirty lane reports `needs_commit` rather than committing on the user's behalf |

## Open questions

1. **Base branch selection.** Current `HEAD` is the obvious default, but long-lived lanes drift. Offer rebase-onto-base as an explicit action, or leave it to the terminal?
2. **Carry-over drift.** If the user edits `.env` in the primary checkout after lanes exist, nothing propagates. Detect and offer to re-sync, or accept the drift as the price of isolation?
3. **Monorepo setup scope.** Should `setup` run at the repo root, or per changed package? Root is simpler and slower.
