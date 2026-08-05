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

| Provider | Expected tier (initial) |
| --- | --- |
| Codex | Structured (app-server) when available |
| Claude Code | Stream (or structured if/when offered) |
| Cursor | Stream |
| Others | Best available; PTY fallback allowed |

## Capability honesty

If a provider cannot interrupt, resume, or emit approvals, the capability matrix must say so. Do not emulate fake approvals in the UI.

## Related

- [Adapter protocol](../architecture/adapter-protocol.md)
- [MVP](mvp.md)
- [Roadmap](../roadmap.md)
