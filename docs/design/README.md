# Design system — Divisio

A dense, quiet workspace for people who keep several agents running at once. Neutral surfaces, hairline borders, and near-zero chrome, so the transcript and the diff are the only things competing for attention.

| Doc | Contents |
| --- | --- |
| [tokens.md](tokens.md) | Light + dark color tokens (semantic) |
| [materials.md](materials.md) | Window vibrancy vs solid composer/menus |
| [typography.md](typography.md) | Font stacks + type scale |
| [layout.md](layout.md) | Three-pane shell, density, surfaces |
| [components.md](components.md) | Composer, sidebar, chat, tools, terminal |
| [motion.md](motion.md) | Animation rules |
| [theme-modes.md](theme-modes.md) | Light / dark / system behavior |

Skills for craft reviews: [`.agents/skills/emil-design-eng`](../../.agents/skills/emil-design-eng), `apple-design`, animation helpers.

## North star

1. **Light mode** — white and zinc hierarchy, hairline borders, a large rounded composer, blue reserved for links, focus rings, and the rare solid CTA.
2. **Dark mode** — near-black canvases with luminosity (not hue) carrying selection and hover state. No colored fills for ordinary UI.
3. **Shell** is always: projects/threads | transcript + composer (+ optional bottom terminal) | working surfaces (Changes / Browser / Terminal / Files).
4. **Materials** — window may be vibrant/translucent; **composer and menus stay solid** (see [materials.md](materials.md)).
5. **Speed of feel beats decoration** — see [motion.md](motion.md) and [performance](../architecture/performance.md).
6. **The agent is the product, not the frame.** Every pixel of chrome competes with the work.

## Implementation rules

- Tokens live as CSS custom properties on `:root` / `.dark` (or `html.dark`)
- Components consume **semantic** tokens only (`--background`, `--sidebar-row-selected`, …) — never raw hex in JSX
- Theme switch applies a `.no-transitions` flash-guard for one frame so colors snap instead of tweening
- Bundle fonts locally if we leave the system stack (size budget still applies)

## Forbidden

- Vendoring any third-party product's stylesheet or UI package
- Purple-glow “AI product” defaults
- Heavy card chrome in the hero/empty chat state
- Animating ⌘K / thread switch / send
