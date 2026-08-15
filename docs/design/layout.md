# Layout

## Shell

Three panes:

```text
┌────────────────┬───────────────────────────────┬────────────────────┐
│ LEFT           │ CENTER                        │ RIGHT              │
│ ~240–280px     │ flex                          │ ~320–400px or      │
│ projects +     │ transcript + composer         │ collapsed to rail  │
│ threads        │ (+ docked terminal optional)  │ surfaces           │
└────────────────┴───────────────────────────────┴────────────────────┘
```

| Pane | Contents |
| --- | --- |
| **Left** | App name / search (⌘K), New chat, Projects tree, thread rows + relative time, Settings footer |
| **Center** | Breadcrumb `project / thread`, actions (open in editor, git), transcript or empty headline, composer, optional bottom terminal |
| **Right** | “Open a surface” empty state **or** tabs: Changes, Browser, Terminal, Files |

Defaults (persist locally):

| Token / setting | Default |
| --- | --- |
| Left width | `260px` (min ~200, max ~360) |
| Right width | `360px` (min ~280); `0` when collapsed to icon rail |
| Double-click resize rail | Reset to default |
| Top bar | `52px` (`--workspace-topbar-height`) |

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
