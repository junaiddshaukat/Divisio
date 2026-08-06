# Materials

How surfaces relate to the window. Competitors in this category split **window vibrancy** from **solid chrome**; Divisio does the same.

## Rule

| Layer | Treatment | Why |
| --- | --- | --- |
| **Window / shell** | Native under-window vibrancy (desktop) + translucent sidebar/main tint | Wallpaper color bleeds; the app feels like macOS chrome |
| **Composer (prompt box)** | **Solid** fill (`--composer-surface`), hairline border, **no** `backdrop-filter` | Reads as a real input, not a smear over the hero |
| **Menus / pickers / dialogs** | **Solid** fill (`--menu-surface`), hairline border, soft shadow, **no** glass | Opaque so transcript/hero never bleed through labels |
| **Floating toasts / palette** | Solid or near-solid popover | Same as menus |

Glass is **only** for the window. Do not frost the composer or the model picker.

## Tokens

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--composer-surface` | `#1c1c1e` | `#ffffff` | Prompt box fill |
| `--chat-composer-outline` | white @ 12% | black @ 10% | Prompt box edge |
| `--menu-surface` | `#1a1a1a` | `#ffffff` | Agent/model menu, similar popovers |
| `--menu-border` | `#333333` | black @ 12% | Menu edge |
| `--menu-row-hover` | `#2a2a2a` | black @ 5% | Row hover |
| `--menu-row-active` | `#2d2d2d` | black @ 7% | Selected / active row |

## Geometry (aligned with category norms)

| Token | Value |
| --- | --- |
| `--radius` | `0.625rem` (10px) |
| `--control-radius` | `0.5rem` (8px) |
| `--radius-composer` | `1.25rem` | Prompt box (slightly rounder than cards) |
| `--radius-user-message` | `0.8rem` |
| Menu corner | ~12px (`border-radius: 12px`) |
| Menu row height | 28px |
| Topbar height | `52px` |

## Type

- UI: system stack (`-apple-system` …) — SF Pro on macOS
- Mono: JetBrains Mono → SF Mono fallback
- Dense chrome at 12–13px; chat leading relaxed (~1.5–1.65)

## Focus

Prefer a quiet hairline or soft `ring` over a loud colored glow on the composer and menus. Reserve `--ring` for keyboard `:focus-visible` on interactive chrome that needs it.
