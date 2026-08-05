import { EVENT_VERSIONS, type EventType, isEventType } from "./events.ts";

/**
 * Read-time event upcasting (ADR 0004).
 *
 * Stored bytes are never rewritten. An event written at v1 stays v1 on disk
 * forever; it is upcast to the current shape each time it is read. A migration
 * that mutates historical events is prohibited — it destroys the only record of
 * what actually happened.
 *
 * When bumping a version:
 *   1. Raise the number in EVENT_VERSIONS
 *   2. Add the (from -> from+1) step here in the SAME commit
 *   3. Add a fixture at the old version to the replay test
 */

/** Transforms a payload one version forward. Pure. */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

/** Keyed `${type}:${fromVersion}`. Registry is intentionally explicit. */
const UPCASTERS: Record<string, Upcaster> = {
  // No versions have been bumped yet. Example of the shape:
  // "turn.message:1": (p) => ({ ...p, role: p.role ?? "assistant" }),
};

export class UpcastError extends Error {}

/**
 * Brings a stored payload up to the current version for its type.
 *
 * Throws on a missing step rather than guessing: a silently wrong upcast
 * corrupts every projection built from it, and the failure surfaces far from
 * the cause.
 */
export function upcast(
  type: EventType,
  fromVersion: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const target = EVENT_VERSIONS[type];

  if (fromVersion > target) {
    // Written by a newer daemon. Callers decide whether to skip; see readers.
    throw new UpcastError(`${type} v${fromVersion} is newer than supported v${target}`);
  }

  let current = payload;
  for (let v = fromVersion; v < target; v++) {
    const step = UPCASTERS[`${type}:${v}`];
    if (!step) {
      throw new UpcastError(`missing upcaster ${type}:${v} -> ${v + 1}`);
    }
    current = step(current);
  }
  return current;
}

/**
 * Whether a stored row can be read at all.
 *
 * Strict on write, tolerant on read: an unknown type is rejected at append
 * time, but on read it is skipped with a warning so that a newer daemon's
 * events cannot brick an older one.
 */
export function isReadable(type: string, v: number): type is EventType {
  return isEventType(type) && v <= EVENT_VERSIONS[type];
}
