# Glossary

Use these terms in docs, code, and agent prompts.

| Term | Meaning |
| --- | --- |
| **Divisio** | This product (working name). The local command center, not a coding model. |
| **User** | Person directing agents through Divisio. |
| **Agent** | Coding agent runtime the user runs *inside* Divisio (Claude Code, Codex, …). |
| **Provider** | Same as agent runtime/harness Divisio talks to (`codex`, `claude`, …). |
| **Adapter** | Code that translates between Divisio contracts and a provider’s native protocol. |
| **Client** | Web or desktop UI connected to a daemon. |
| **Environment** | One running daemon plus the machine, filesystem, credentials, and userdata it owns. |
| **Project** | Environment-local workspace record rooted at a directory (usually a git repo). |
| **Thread** | Durable conversation / work history for a project (may span handoffs). |
| **Turn** | One user→agent cycle, including tools, until completion, interrupt, or error. |
| **Session** | Live provider process attachment for a thread (connecting → ready → running → …). |
| **Worktree** | Git worktree isolating a parallel lane’s files and branch. |
| **Checkpoint** | Snapshot marker (typically a hidden git ref) taken around a turn for diff/restore. |
| **Handoff** | Moving work to another provider with a continuation packet and event linkage. |
| **Continuation packet** | Bounded context export used to seed a handoff target. |
| **Projection** | Read model derived from the event log for the UI. |
| **Capability matrix** | Declared adapter features the UI trusts (resume, approvals, …). |
| **Pairing token** | One-time secret binding a client to a daemon. |
| **Tier** | Adapter integration level: structured, stream, or PTY. |

## Anti-glossary (avoid)

| Phrase | Why |
| --- | --- |
| “Divisio model” | We don’t sell models |
| “a fork of X” | We wrote this; describe it on its own terms |
| “Just wrap the CLI in the UI” | Omits orchestration, permissions, and projections |
