import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadView } from "@divisio/contracts";
import { needsAttention, statusOf } from "../status.ts";

/**
 * Cross-thread attention.
 *
 * Supervising several agents is the whole premise, but a thread that blocks on
 * an approval while you are reading a different one has, until now, announced
 * itself with nothing more than a coloured dot in a sidebar you may have
 * collapsed. Work stalls and the user finds out minutes later.
 *
 * Three escalating signals, each cheap and each dismissible:
 *   1. the document title, so a background tab shows a count
 *   2. an in-app toast that jumps to the thread
 *   3. an OS notification, only if the user has already granted permission —
 *      we never prompt for it, because a permission prompt on first run is how
 *      an app teaches people to click "block"
 */

export interface AttentionItem {
  threadId: string;
  title: string;
  reason: string;
}

const BASE_TITLE = "Divisio";

export function useAttention(threads: ThreadView[], activeThreadId: string | null) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  /** Statuses already announced, so a re-render is not a second alert. */
  const announced = useRef<Map<string, string>>(new Map());

  const items = useMemo<AttentionItem[]>(
    () =>
      threads
        .filter((t) => needsAttention(t.status))
        // The thread you are looking at speaks for itself.
        .filter((t) => t.id !== activeThreadId)
        .filter((t) => !dismissed.has(`${t.id}:${t.status}`))
        .map((t) => ({ threadId: t.id, title: t.title, reason: statusOf(t.status).label })),
    [threads, activeThreadId, dismissed],
  );

  // Title reflects the count so a backgrounded window still reports it.
  useEffect(() => {
    document.title = items.length > 0 ? `(${items.length}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [items.length]);

  // One OS notification per thread per status transition, and only when the
  // window is not already in front of the user.
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const item of items) {
      const previous = announced.current.get(item.threadId);
      if (previous === item.reason) continue;
      announced.current.set(item.threadId, item.reason);
      if (document.visibilityState === "visible") continue;
      new Notification(`${item.reason}: ${item.title}`, {
        body: "A thread is waiting on you.",
        tag: item.threadId,
      });
    }
    for (const id of announced.current.keys()) {
      if (!items.some((i) => i.threadId === id)) announced.current.delete(id);
    }
  }, [items]);

  const dismiss = (threadId: string) => {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    // Keyed by status, so the same thread blocking again later still alerts.
    setDismissed((prev) => new Set(prev).add(`${threadId}:${thread.status}`));
  };

  return { items, dismiss };
}
