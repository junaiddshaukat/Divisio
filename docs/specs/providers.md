# Providers

Divisio drives **already-authenticated** CLIs. Installing Divisio does not replace `claude auth login`, `codex login`, `cursor-agent login`, `grok` auth, etc.

## Priority matrix

| Priority | Providers | Phase | Notes |
| --- | --- | --- | --- |
| **P0** | Claude Code, Codex, Cursor CLI | 1 | First-party (`source: builtin`) |
| **P1** | Grok Build, Qwen Code, OpenCode | 2–4 | First-party stream adapters |
| **P2** | Gemini CLI, GitHub Copilot, Antigravity | 4 | Community pack `@divisio/community-adapters` |
| **P2+** | Kilo Code, Pi, Droid, … | 4+ | Prefer external SDK packages |
| **P3** | Windsurf, Devin CLI, others | 4+ | Likely PTY tier until better protocols exist |

## Prerequisites (illustrative)

| Provider | Typical setup |
| --- | --- |
| Codex | Codex CLI + `codex login` |
| Claude Code | Claude Code CLI + `claude auth login` |
| Cursor | Cursor CLI + `cursor-agent login` |
| Grok Build | xAI Grok CLI (`grok`) authenticated |
| Qwen Code | Qwen Code CLI (`qwen`) + ModelScope / vendor auth |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` + `opencode auth login` |
| Gemini CLI | `npm i -g @google/gemini-cli` + auth |
| GitHub Copilot | `npm i -g @github/copilot` + GitHub auth |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` → `agy` |

## Adapter tier expectations

| Provider | Tier | Status | Source |
| --- | --- | --- | --- |
| Codex | Structured (`codex app-server`) | `CodexAdapter` | builtin |
| Claude Code | Stream (`stream-json`) | `ClaudeAdapter` | builtin |
| Cursor | Stream (`cursor-agent` stream-json) | `CursorAdapter` | builtin |
| Grok Build | Stream (`streaming-json`) | `GrokAdapter` | builtin |
| Qwen Code | Stream (`stream-json`) | `QwenAdapter` | builtin |
| OpenCode | Stream (`opencode run --format json`) | `OpenCodeAdapter` | builtin |
| Gemini CLI | Stream (`--output-format stream-json`) | `GeminiAdapter` | community |
| GitHub Copilot | Stream (`--output-format json`) | `CopilotAdapter` | community |
| Antigravity | Stream (`agy --output-format stream-json`) | `AntigravityAdapter` | community |

### Community P2 spawn notes

- **Gemini:** `gemini -p <prompt> --output-format stream-json [--resume <id>] [--yolo]`
- **Copilot:** `copilot -p <prompt> --output-format json -s --no-ask-user [--allow-all]`
- **Antigravity:** `agy -p <prompt> --output-format stream-json [--conversation <id>] [--dangerously-skip-permissions]`

Load extra community modules with `DIVISIO_ADAPTER_MODULES` or `userdata/adapters.json`. See [Adapter SDK](../sdk/adapter-sdk.md).

## Model lists

The composer picker prefers a **live** catalog from `provider.models` when an adapter can list one without starting a login:

| Provider | Live source |
| --- | --- |
| Qwen Code | `$QWEN_HOME/settings.json` (default `~/.qwen/settings.json`) `modelProviders` — this is how ModelScope / Ambassador models appear |
| Codex | `$CODEX_HOME/models_cache.json` |

If listing fails or the adapter has no `listModels`, the UI falls back to curated aliases. Divisio does not invent vendor model names.

## Capability honesty

Never fake approvals. Print/headless modes leave permissions with the CLI (`approvals: false`) unless a mediated protocol exists.

Settings → Providers shows the declared matrix as Yes/No. Missing flags render as No.

Vendor session ids are persisted on the event log (`thread.vendor_session_set`) and passed back as `resumeId` only when `sessionResume` is true. Each start records `session.resume_outcome` so a cold or failed resume is first-class, not inferred from a continuous-looking transcript. If the CLI cannot resume, the composer says the next prompt starts a new vendor conversation.

`usageSignals` is true only when the adapter maps vendor token counts onto `usage.reported` / `turn.usage`. Missing counters stay absent; adapters must not invent numbers.

Settings → Usage reads Claude Code and Codex session files on this machine (`~/.claude/projects`, `$CODEX_HOME/sessions`) and sums processed tokens: uncached input + cache read + cache write + output. Cache hits are the bulk of that number. Divisio-orchestrated `turn.usage` is shown as a footnote and is not added on top. It is not billed spend and not a vendor quota. Other agents without on-disk counters still appear as unmetered when they ran through Divisio.

CLIs often show their own "92% of quota" banners inside the vendor TUI. Divisio does not receive that percentage unless an adapter maps it. When a turn fails with a rate-limit or quota error, the UI offers **Hand off** and orchestration seeds the next agent from the event log so the limited CLI does not have to write a note.

Divisio permission modes are **supervised** and **full access**. Vendor session modes (Plan / Agent / Ask and similar) stay on the CLI. Do not add a Divisio mode picker that claims to switch a CLI into a mode the adapter cannot actually set.

## Related

- [Adapter protocol](../architecture/adapter-protocol.md)
- [Adapter SDK](../sdk/adapter-sdk.md)
- [Roadmap](../roadmap.md)
