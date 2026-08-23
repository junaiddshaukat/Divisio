import { useEffect, useRef, useState } from "react";

/**
 * Reveals streamed text with a light typewriter catch-up so large provider
 * chunks still feel like token streaming instead of jumping.
 *
 * Always starts from empty for a new target — initializing to the full chunk
 * is what made the caret appear and then dump the whole answer at once.
 */

export function nextRevealLength(shown: number, target: number): number {
  if (target <= shown) return target;
  const lag = target - shown;
  const step = lag > 80 ? Math.ceil(lag / 6) : lag > 24 ? 4 : 2;
  return Math.min(target, shown + step);
}

/** Minimum gap between reveal commits. ~25 commits/sec, not 60-120. */
const MIN_EMIT_INTERVAL_MS = 40;

export function useSmoothReveal(target: string, active: boolean): string {
  const [shown, setShown] = useState("");
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (!active) {
      setShown(target);
      return;
    }
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(target);
      return;
    }
    if (target.length < shownRef.current.length) {
      setShown(target);
      return;
    }
    if (target === shownRef.current) return;

    let frame = 0;
    let lastEmit = 0;
    const tick = () => {
      const current = shownRef.current;
      if (current.length >= target.length) {
        setShown(target);
        return;
      }
      const next = target.slice(0, nextRevealLength(current.length, target.length));
      shownRef.current = next;
      // rAF runs at 60-120Hz. Committing on every frame turned each token into
      // a full markdown re-parse; gate commits to MIN_EMIT_INTERVAL_MS so the
      // reveal stays smooth without re-rendering at display refresh rate.
      const now = performance.now();
      if (now - lastEmit >= MIN_EMIT_INTERVAL_MS) {
        lastEmit = now;
        setShown(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active]);

  return active ? shown : target;
}
