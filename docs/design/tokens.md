# Color tokens

Semantic token names follow the **shadcn** convention, which is de facto standard across the ecosystem — engineers coming from any shadcn-based codebase map to these immediately. The values are tuned for a dense, low-chrome agent workspace in both modes.

Apply with `color-scheme: light | dark`. Prefer `oklch` / zinc scales where noted; hex below is the **authoritative MVP palette** for designers.

## Radius + chrome geometry

| Token | Value | Notes |
| --- | --- | --- |
| `--radius` | `0.625rem` (10px) | Base |
| `--radius-sm` | `calc(var(--radius) - 4px)` | Chips, small controls |
| `--radius-md` | `calc(var(--radius) - 2px)` | Buttons |
| `--radius-lg` | `var(--radius)` | Cards, surface tiles |
| `--radius-xl` | `calc(var(--radius) + 4px)` | Composer shell |
| `--radius-user-message` | `0.8rem` | User bubbles |
| `--control-radius` | `0.5rem` | Compact controls |
| `--workspace-topbar-height` | `52px` | Titlebar / drag region |
| `--app-scrollbar-width` | `8px` | Visible overlay scrollbars |

## Light mode (`:root`)

Target: white canvas, zinc sidebar well.

| Token | Value | Role |
| --- | --- | --- |
| `--background` | `#FCFCFC` | App canvas (off-white, softer than pure white) |
| `--app-chrome-background` | `var(--background)` | Window chrome |
| `--foreground` | `#27272A` | Primary text (zinc-800) |
| `--foreground-subtle` | `#A1A1AA` | Tertiary chrome (timestamps, resting icons) |
| `--card` | `#FFFFFF` | Raised panels, composer fill, popovers |
| `--card-foreground` | `var(--foreground)` | |
| `--popover` | `#FFFFFF` | Menus |
| `--popover-foreground` | `var(--foreground)` | |
| `--primary` | `#18181B` | Solid CTA / send (neutral, not a loud blue) |
| `--primary-foreground` | `#FFFFFF` | |
| `--secondary` | `rgba(0,0,0,0.04)` | Quiet fills |
| `--secondary-foreground` | `var(--foreground)` | |
| `--muted` | `rgba(0,0,0,0.04)` | Soft wells |
| `--muted-foreground` | `#71717A` | Placeholders, meta |
| `--accent` | `rgba(0,0,0,0.04)` | Hover wash |
| `--accent-foreground` | `#18181B` | |
| `--border` | `rgba(0,0,0,0.08)` | Hairlines (zinc-200 weight) |
| `--input` | `rgba(0,0,0,0.10)` | Input outline |
| `--ring` | `#526FFF` | Focus ring / link accent |
| `--destructive` | `#EF4444` | Deny / danger |
| `--destructive-foreground` | `#B91C1C` | Text on tint |
| `--info` | `#3B82F6` | Update / info CTA fill |
| `--info-foreground` | `#1D4ED8` | |
| `--success` | `#10B981` | |
| `--success-foreground` | `#047857` | |
| `--warning` | `#F59E0B` | Full-access / caution banners |
| `--warning-foreground` | `#B45309` | |
| `--sidebar` | `#F4F4F5` | Sidebar well (zinc-100) |
| `--sidebar-foreground` | `var(--foreground)` | |
| `--sidebar-muted-foreground` | `var(--muted-foreground)` | |
| `--sidebar-control-surface` | `#E4E4E7` | Search / control chips |
| `--sidebar-row-hover` | `#FAFAFA` | |
| `--sidebar-row-active` | `#FFFFFF` | |
| `--sidebar-row-selected` | `#FFFFFF` | Selected thread pill |
| `--sidebar-border` | `var(--border)` | |
| `--surface-raised` | transparent / light card mix | Overlays |
| `--chat-composer-outline` | `rgba(0,0,0,0.08)` | Composer border |
| `--user-bubble` | `#F4F4F5` | User message fill |
| `--code-block` | `#F4F4F5` | Inline code / fence bg |
| `--app-scrollbar-thumb` | `rgb(217 217 217)` | |
| `--app-scrollbar-thumb-hover` | `rgb(191 191 191)` | |

**Light accent usage:** blue (`--info` / `--ring`) only for links, focus rings, and rare solid CTAs (e.g. “Update”). Default buttons stay `--primary` near-black.

## Dark mode (`.dark` or `@variant dark`)

Target: near-black canvas, luminosity-driven state.

| Token | Value | Role |
| --- | --- | --- |
| `--background` | `#111111` | App canvas (lifted charcoal) |
| `--app-chrome-background` | `var(--background)` | |
| `--foreground` | `#F4F4F5` | Primary text |
| `--foreground-subtle` | `#8A8A8A` | Tertiary chrome |
| `--card` | `#181818` | Lifted panel |
| `--card-foreground` | `var(--foreground)` | |
| `--popover` | `#1C1C1C` | Menus |
| `--popover-foreground` | `var(--foreground)` | |
| `--primary` | `#F4F4F5` | Solid CTA on dark |
| `--primary-foreground` | `#18181B` | |
| `--secondary` | `rgba(255,255,255,0.04)` | |
| `--secondary-foreground` | `var(--foreground)` | |
| `--muted` | `rgba(255,255,255,0.06)` | |
| `--muted-foreground` | `#A8A8AE` | Secondary copy, placeholders |
| `--accent` | `rgba(255,255,255,0.07)` | Hover wash |
| `--accent-foreground` | `var(--foreground)` | |
| `--border` | `rgba(255,255,255,0.10)` | Hairlines |
| `--input` | `rgba(255,255,255,0.12)` | |
| `--ring` | `#6073CC` | Focus |
| `--destructive` | color-mix red toward white | |
| `--destructive-foreground` | `#F87171` | |
| `--info` | `#3B82F6` | |
| `--info-foreground` | `#93C5FD` | |
| `--success` | `#10B981` | |
| `--success-foreground` | `#34D399` | |
| `--warning` | `#F59E0B` | |
| `--warning-foreground` | `#FBBF24` | |
| `--sidebar` | `#0C0C0C` | Sunken rail, darker than the canvas |
| `--sidebar-foreground` | `var(--foreground)` | |
| `--sidebar-muted-foreground` | `var(--muted-foreground)` | |
| `--sidebar-control-surface` | `var(--muted)` | |
| `--sidebar-row-hover` | foreground @ 6% | Hover pill (ΔL ~0.04) |
| `--sidebar-row-active` | foreground @ 10% | |
| `--sidebar-row-selected` | foreground @ 12% | Selected (stronger than hover) |
| `--sidebar-border` | `var(--border)` | |
| `--user-bubble` | `rgba(255,255,255,0.06)` | |
| `--code-block` | `rgba(255,255,255,0.05)` | |
| `--chat-composer-outline` | white @ 14% | |
| `--app-scrollbar-thumb` | `rgb(255 255 255 / 22%)` | |
| `--app-scrollbar-thumb-hover` | `rgb(255 255 255 / 36%)` | |

True-black option: `--background: #000` is allowed as an “OLED” preference later; default ships `#111111` so the rail and composer can sit darker / lighter against it.

On desktop the **window** may be vibrant; `--background` on `.main` stays opaque so wallpaper cannot wash the canvas. The sidebar may sit slightly translucent (`~88%`) as a sunken rail — never CSS-blurred on top of native vibrancy.

Text hierarchy is three quiet levels: `--foreground` (primary), `--muted-foreground` (secondary), `--foreground-subtle` (tertiary). Do not use muted for interactive nav.

## Status colors (shared)

| Token | Light | Dark intent |
| --- | --- | --- |
| `--status-success` | `--success` | mix toward white ~72% |
| `--status-failure` | `--destructive` | mix toward white |
| `--status-open` | emerald family | same |
| `--status-merged` | indigo-500 | mix toward white |
| `--status-neutral` | zinc-500 | mix toward white |

## Do / don’t

| Do | Don’t |
| --- | --- |
| Define selection with `--sidebar-row-*` | Paint selection with random blue fills |
| Use borders at 6–10% opacity | Heavy 1px black rules everywhere |
| Keep accent sparse | Rainbow icons / glow stacks |
| Bubble the user, leave the assistant flush on canvas | Bubble both sides identically |

## Mapping when implementing

| Tailwind / UI role | Token |
| --- | --- |
| `bg-background` | `--background` |
| `bg-card` | `--card` |
| `bg-sidebar` | `--sidebar` |
| `text-muted-foreground` | `--muted-foreground` |
| `border-border` | `--border` |
| `bg-primary` | `--primary` |
