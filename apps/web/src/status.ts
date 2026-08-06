import type { SessionStatus, ThreadView } from "@divisio/contracts";

/**
 * Thread status as data, not markup.
 *
 * One definition, rendered by the sidebar, the board, and the topbar. When
 * status lives in each component, the same state ends up a different colour in
 * each pane and nobody notices until a user asks which one is right.
 */

export interface StatusPresentation {
  label: string;
  /** CSS class carrying the colour; see styles/status.css. */
  tone: "attention" | "busy" | "ready" | "error" | "idle";
  /** Only states that are genuinely in motion pulse. */
  pulse: boolean;
  /**
   * Higher wins when rolling a group up to one indicator. A collapsed project
   * should surface the thread that most needs a person, not the newest one.
   */
  priority: number;
}

const PRESENTATION: Record<SessionStatus, StatusPresentation> = {
  awaiting_approval: { label: "Needs approval", tone: "attention", pulse: false, priority: 5 },
  error: { label: "Error", tone: "error", pulse: false, priority: 4 },
  running: { label: "Working", tone: "busy", pulse: true, priority: 3 },
  stopping: { label: "Stopping", tone: "attention", pulse: true, priority: 3 },
  connecting: { label: "Connecting", tone: "busy", pulse: true, priority: 2 },
  ready: { label: "Idle", tone: "ready", pulse: false, priority: 1 },
  closed: { label: "Closed", tone: "idle", pulse: false, priority: 0 },
};

export function statusOf(status: SessionStatus): StatusPresentation {
  return PRESENTATION[status] ?? PRESENTATION.closed;
}

/**
 * The most urgent status among a set of threads.
 *
 * Used for collapsed project groups: a group that hides a thread waiting on an
 * approval must still say so, or collapsing becomes a way to lose work.
 */
export function rollUp(threads: ThreadView[]): StatusPresentation | null {
  if (threads.length === 0) return null;
  return threads
    .map((t) => statusOf(t.status))
    .reduce((best, next) => (next.priority > best.priority ? next : best));
}

/** True when a status warrants pulling the user's eye across the whole app. */
export function needsAttention(status: SessionStatus): boolean {
  return statusOf(status).priority >= 4;
}
