# Layout

## Shell

Three panes:

```text
┌──────────────────────────────────────────────────────────────────┐
│ traffic · sidebar toggle · search     crumb              actions │
├────────────────┬─────────────────────────────────┬───────────────┤
│ LEFT           │ CENTER                          │ RIGHT         │
│ ~240–280px     │ transcript + composer           │ ~320–400px or │
│ projects +     │ (+ docked terminal optional)    │ collapsed     │
│ threads        │                                 │               │
└────────────────┴─────────────────────────────────┴───────────────┘
```

| Pane | Contents |
| --- | --- |
| **Title bar** | Full-window chrome: macOS traffic lights, sidebar toggle (always visible), search (⌘K), breadcrumb `project / thread`, actions (open in editor, git, surfaces) |
| **Left** | App name, New chat, Projects tree, thread rows + relative time, Settings footer |
| **Center** | Transcript or empty headline, composer, optional bottom terminal |
| **Right** | “Open a surface” empty state **or** Changes, Browser, Files |

Defaults (persist locally):

| Token / setting | Default |
| --- | --- |
| Left width | `260px` (min ~200, max ~360) |
| Right width | `360px` (min ~280); `0` when collapsed to icon rail |
| Double-click resize rail | Reset to default |
| Top bar | `38px` (`--workspace-topbar-height`) |

## Density

Density scales spacing, never color:

| Mode | `--density-scale` | Feel |
| --- | --- | --- |
| Compact | `0.85` | Power users |
| Comfortable | `1.0` | Default |
| Spacious | `1.15` | Accessibility / demos |

Apply scale to sidebar row padding, composer padding, chat gutters — not font size (font size is a separate setting).

## Insets

| Token | Value |
| --- | --- |
| `--sidebar-content-inset` | `0.5rem` |
| `--sidebar-row-content-inset` | `0.625rem` |
| `--command-shell-inset` | `0.5rem` |
| `--command-content-inset` | `1rem` |
| `--floating-content-inset` | `0.75rem` |

## Empty states

**No thread selected** and **empty draft thread** share one composition: large `display` question (“What should we build?”) above a large composer (or a composer-shaped control that starts a chat). Not a muted title and a distant button. No ghost “No thread selected” header.

**Right (no surface):** titled “Open a surface” + 2×2 tiles — Browser, Terminal, Files, Diff (Diff disabled until changes exist).

## Terminal docking

The terminal **splits the center column** under the chat, not only as a right surface. Support both:

1. Right-surface Terminal tab  
2. Bottom dock in center (height user-resizable, remembered)

## Responsive (web)

- &lt; 900px: collapse right to overlay drawer; left becomes sheet  
- Desktop Tauri: always three-pane capable
