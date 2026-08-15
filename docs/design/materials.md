# Materials

How surfaces relate to the window. Desktop workspaces in this category split **window vibrancy** from **solid chrome**; Divisio does the same.

## Rule

| Layer | Treatment | Why |
| --- | --- | --- |
| **Window** | Native under-window vibrancy (desktop) around chrome | Wallpaper may tint the rail; the app still feels like macOS chrome |
| **Main canvas / `.main`** | **Opaque** `--background` | Wallpaper must not wash the work surface |
| **Sidebar** | Sunken vs canvas (`#111` dark / zinc-100 light). Slight translucency on desktop only — **no** stacked CSS blur | Elevation from luminosity, not frost |
| **Composer (prompt box)** | **Solid** fill (`--composer-surface`), hairline border, **no** `backdrop-filter` | Reads as a real input, not a smear over the hero |
| **Menus / pickers / dialogs / palette** | **Solid** `--menu-surface`, hairline, `--shadow-menu` (shadow + 1px foreground ring), **no** glass | Opaque so transcript never bleeds through labels |

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
| `--shadow-menu` | `--shadow-md` + 1px fg ring | same | Floating chrome edge |

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
