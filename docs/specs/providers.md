# Providers

Divisio drives **already-authenticated** CLIs. Installing Divisio does not replace `claude auth login`, `codex login`, `agent login`, etc.

## Priority matrix

| Priority | Providers | Phase | Notes |
| --- | --- | --- | --- |
| **P0** | Claude Code, Codex, Cursor CLI | 1 | Must ship for Core MVP |
| **P1** | Grok Build, OpenCode, Antigravity | 2–4 | First-party when stable; else high-value community |
| **P2** | Kilo Code, Pi, Droid, Gemini CLI, Copilot CLI, … | 4+ | Prefer community adapters via SDK |
| **P3** | Windsurf, Devin CLI, others | 4+ | Likely PTY tier until better protocols exist |

Exact binary names and detect heuristics are locked in code during implementation; docs stay intent-level until then.

## Prerequisites (illustrative)

Users must install and auth at least one provider before useful work:

| Provider | Typical setup |
| --- | --- |
| Codex | Codex CLI + `codex login` |
| Claude Code | Claude Code CLI + `claude auth login` |
| Cursor | Cursor CLI + `agent login` |
| Grok Build | Grok CLI + `grok login` |
| OpenCode | OpenCode + `opencode auth login` |
| Antigravity | `agy` CLI authenticated per vendor docs |

## Adapter tier expectations

| Provider | Expected tier (initial) | Status |
| --- | --- | --- |
| Codex | Structured (`codex app-server`) | Implemented (`CodexAdapter`) |
| Claude Code | Stream (`--print --output-format stream-json`) | Implemented (`ClaudeAdapter`) |
| Cursor | Stream (`cursor-agent --print … stream-json`) | Implemented (`CursorAdapter`) |
| Others | Best available; PTY fallback allowed | — |

### Codex (Structured)

- Binary: `codex` on PATH; session transport is `codex app-server` (NDJSON JSON-RPC, no `"jsonrpc":"2.0"` field).
- Handshake: `initialize` → notify `initialized` → `thread/start` or `thread/resume` (resume falls back to start).
- Turns: `turn/start` with `input: [{ type: "text", text }]`; interrupt via `turn/interrupt`.
- Approvals: server requests `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` → `approval.requested`; Divisio replies `accept` / `decline`.
- Capabilities: `sessionResume`, `interruptTurn`, `approvals`, `worktreeAware`. No usage signals yet.
- Detect: `codex --version`; auth remains `codex login` (BYO CLI).

### Claude Code (Stream)

- Print mode owns the permission engine — `approvals: false` until a PreToolUse / supervised path exists.
- Capabilities: `sessionResume`, `interruptTurn`, `worktreeAware`, `usageSignals`.

### Cursor Agent (Stream)

- Binary: prefer `cursor-agent` (not bare `agent` — that is often Grok on PATH).
- Spawn: `cursor-agent --print --output-format stream-json --stream-partial-output --workspace <cwd> [--resume <id>] <prompt>`.
- Partial-stream filter: only assistant events with `timestamp_ms` and without `model_call_id` are new text.
- Approvals: `false` in print mode (CLI-owned). Mediated approvals need ACP (`cursor-agent acp`) later.
- Capabilities: `sessionResume`, `interruptTurn`, `worktreeAware`. Auth: `cursor-agent login`.
- Detect: `cursor-agent --version`.
## Capability honesty

If a provider cannot interrupt, resume, or emit approvals, the capability matrix must say so. Do not emulate fake approvals in the UI.

## Related

- [Adapter protocol](../architecture/adapter-protocol.md)
- [MVP](mvp.md)
- [Roadmap](../roadmap.md)
