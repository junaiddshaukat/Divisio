# Motion

Use [.agents/skills/emil-design-eng](../../.agents/skills/emil-design-eng) when reviewing UI. Performance doc: [architecture/performance.md](../architecture/performance.md).

## Decision table

| Action frequency | Animate? |
| --- | --- |
| ⌘K, send, thread switch, pane focus, approval approve/deny | **Never** |
| Hover / selected row wash | Instant or ≤80ms opacity |
| Popover / select open | 150–200ms ease-out |
| Modal / drawer | 200–300ms ease-out |
| Toast enter/exit | 180–220ms, same direction in/out |
| Theme toggle | **No color tween** — apply `.no-transitions` during the switch |

## Curves

```text
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
```

Never `ease-in` for UI entry. Prefer transforming `transform`/`opacity`, not `all`.

## Streaming

- Do **not** run continuous “working” CSS animations on the whole transcript
- Status pulse (if any) must be duty-cycled / stepped — never a vsync-bound loop that runs forever
- Auto-scroll only while user is pinned to bottom and assistant text is actually streaming

## Reduced motion

Honor `prefers-reduced-motion: reduce` — snap states, no decorative motion.
