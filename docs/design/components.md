# Components

Specs for the UI pieces that carry the workspace. Implement against [tokens](tokens.md) + [typography](typography.md).

## App sidebar

| Element | Spec |
| --- | --- |
| Search | Full-width control on `--sidebar-control-surface`; shortcut hint `⌘K` in `--muted-foreground` |
| Nav rows | New chat, optional Automations/PRs — icon + label, `ui` size |
| Project folder | Folder icon + name; chevron; threads nested with indent |
| Thread row | Title ellipsis + relative time (`4m`, `1d`); selected = `--sidebar-row-selected` rounded pill (~8–10px) |
| Footer | Settings gear; optional account row — keep quiet for OSS MVP |

## Center header

| Element | Spec |
| --- | --- |
| Breadcrumb | `project / thread` muted separators |
| Actions | Icon buttons: add, Open in {Cursor, VS Code, Finder}, Initialize Git |
| Menus | Floating `--popover`, soft shadow, 8–12px radius |

## Transcript

| Element | Spec |
| --- | --- |
| User | Right-aligned or inset bubble `--user-bubble`, `--radius-user-message` |
| Assistant | Flush left, no bubble |
| Meta row | Hover-only copy / feedback; timestamp `meta` |
| Code fence | `--code-block` bg, mono, header with language + copy + expand |
| Banner | Full-access / warning strip with `--warning` icon; dismiss + “Don’t show again” |

## Composer (critical)

Large shell with a compact control bar along the bottom:

| Part | Spec |
| --- | --- |
| Shell | `--card` fill, `--chat-composer-outline`, `--radius-xl`, generous padding |
| Placeholder | “Ask for follow-up…” / “Do anything.” in muted |
| Permission pill | “Allow commands…” or “Full access” — warning-tint when elevated |
| Model select | Dropdown inside composer footer |
| Privacy / mode | Second select (Full access / supervised) |
| Send | Circular or rounded `--primary` control; disabled when empty |
| Attach | `+` leading control |
| Voice | Optional mic icon — can stub |

Empty-thread composer sits **vertically centered** under the display headline. Thread composer docks to **bottom** of center pane.

## Right surfaces

### Empty picker

Four tiles: Browser, Terminal, Files, Diff — icon + title + one-line description. Diff disabled (muted) until changes exist.

### Active tabs

Tab strip: Changes | Browser | Terminal | Files. Active tab uses subtle underline or pill. Content:

| Tab | Content |
| --- | --- |
| Changes | Diff list + file tree |
| Browser | Mini toolbar (back/forward/reload/URL) + webview |
| Terminal | xterm surface, mono |
| Files | Tree browser |

## Floating chrome

| Element | Spec |
| --- | --- |
| Update toast | Card on `--card`, shadow, primary/info button + secondary Settings |
| Env panel | Floating rounded card: Changes / Local / branch; Sources list with favicons |

## Buttons

| Variant | Look |
| --- | --- |
| Primary | `--primary` fill, `--primary-foreground`, `--radius-md` |
| Info CTA | `--info` fill (Update) |
| Ghost | Transparent, hover `--accent` |
| Danger | `--destructive` outline or soft tint |

Press feedback: scale ~0.97, 100–160ms — never on keyboard-triggered actions.

## Icons

Thin-stroke, consistent weight (Lucide-class). No multicolor file-type noise — this is an agent command center, not a full IDE.

## Out of MVP chrome

- Marketing “Upgrade to Pro” blocks — omit, or replace with GitHub connect later
- Agent-vs-Editor mode tabs — not Phase 0
- Dashboard card grids with solid blue headers — not our shell
