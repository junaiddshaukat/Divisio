import { useEffect, useMemo, useState } from "react";
import { rotateWorkingVerbs } from "../thinkingPhrases.ts";

const CYCLE_MS = 2400;

interface Props {
  /** When set, do not cycle — used for handoff. */
  locked?: string | null;
}

/**
 * Wait state before the first streamed token: a rotating verb plus a
 * stepped ellipsis. One interval, not a vsync loop on the transcript.
 */
export function ThinkingStatus({ locked = null }: Props) {
  const verbs = useMemo(() => rotateWorkingVerbs(Date.now()), []);
  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (locked || reduced) return;
    const id = window.setInterval(() => {
      setIndex((n) => (n + 1) % verbs.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [locked, reduced, verbs.length]);

  const word = locked ?? verbs[index] ?? "Thinking";

  return (
    <div className="thinking-status" role="status">
      <span className="visually-hidden">Working</span>
      <span key={word} className="thinking-word" aria-hidden>
        {word}
      </span>
      <span className="thinking-dots" aria-hidden>
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}
