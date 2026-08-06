# v1 ship notes

## Done for v1

- Phases 0–4 roadmap complete (adapters, lanes/board, handoff, desktop, community pack)
- **AgentPicker** in the composer (left: providers, right: curated models)
- Empty thread: `thread.setProvider` switches agent/model without handoff
- Thread with history: provider change runs **Hand off** (one turn on source)
- Model passed to CLIs that accept `--model` (Claude, Cursor, Grok, Qwen, Gemini, Antigravity)

## Known gaps (acceptable for v1; track as v1.1+)

- In-UI Approve/Deny only for **Codex**; Claude/Cursor/stream CLIs stay CLI-managed
- Model lists are curated aliases, not live vendor probes
- No slash commands / attachments / multi-tab terminals / visual redesign

## Smoke gate before tagging v1

1. Claude Code — picker → send → interrupt → Changes diff
2. Grok or Cursor — same
3. Two lanes without clobber + PR path
4. Empty thread: switch provider in picker; non-empty: handoff warning + handoff
