# Typography

Optimize for **native desktop readability**: system UI for chrome and chat, a dedicated mono for code and terminal.

## Font stacks

| Token | Stack | Use |
| --- | --- | --- |
| `--font-sans` / `--font-ui-family` | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` | App chrome, sidebar, chat prose, composer |
| `--font-mono` / `--font-mono-family` | `"JetBrains Mono", "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` | Code fences, diffs, inline code |
| `--font-terminal` | Same as mono; Nerd Font variant optional later | Embedded terminal |
| `--font-display` | Optional later; default = UI stack | Wordmark only if branded |

**MVP decision:** ship **system UI + JetBrains Mono**. Bundle the mono locally; keep sans on the system stack to save bundle size and feel native on each OS. No Inter/Roboto as a brand face.

**Tracking:** `letter-spacing: normal` on UI. Do not squeeze system faces; they are already tuned.

## Type scale

Pixel pairs are for designers; implement as rem in CSS later.

| Name | Size / line | Weight | Where |
| --- | --- | --- | --- |
| `display` | 28–32 / 36–40 | 600 | Empty-state headline (“What should we build…”) |
| `title` | 16–18 / 24 | 600 | Thread title in center header |
| `body` | 14 / 20 | 400 | Chat assistant prose, settings |
| `body-tight` | 13 / 18 | 400 | Dense lists |
| `ui` | 13 / 18 | 500 | Sidebar labels, buttons |
| `meta` | 11–12 / 16 | 400 | Timestamps, shortcuts (⌘K), env footer |
| `code` | 12–13 / 18–20 | 400 | Fences; ligatures **off** in diffs |

Composer input: **14 / 20**.

## Chat typography rules

- **User:** medium weight optional; sits in `--user-bubble`
- **Assistant:** plain left-aligned text on canvas — not a second bubble
- **Code block header:** meta size + mono; copy/expand icons muted
- **Markdown:** clear H2/H3 hierarchy; checklists readable at body size

## Accessibility

- Minimum body contrast against `--background` / `--card` ≥ WCAG AA
- Don’t rely on weight alone for state; use color tokens + icons
