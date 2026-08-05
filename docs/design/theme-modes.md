# Theme modes

## Modes

| Mode | Behavior |
| --- | --- |
| `system` | Follow OS `prefers-color-scheme` |
| `light` | Force light tokens |
| `dark` | Force dark tokens |

Persist in local settings (key TBD, e.g. `orchestrator:theme`). Cross-tab sync optional.

## Application

1. Resolve mode → `light` or `dark`
2. Set `document.documentElement.classList.toggle('dark', isDark)`
3. Set `color-scheme` accordingly
4. During switch, add `.no-transitions` for one frame / rAF, then remove — prevents muddy color interpolation

## Defaults

- **MVP web:** `system`
- QA screenshots in both light and dark required before UI Phase 0 sign-off

## What changes with theme

Everything via tokens in [tokens.md](tokens.md). Components must not hard-code hex.

## Appearance settings (later)

| Setting | Notes |
| --- | --- |
| Theme | system / light / dark |
| UI density | compact / comfortable / spacious |
| Base font size | scales type scale |
| Terminal font | optional override |

Color themes stay **neutral zinc** for v1. Accent packs are Phase 4+ — don’t block MVP.
