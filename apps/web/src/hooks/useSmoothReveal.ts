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
    const tick = () => {
      const current = shownRef.current;
      if (current.length >= target.length) {
        setShown(target);
        return;
      }
      const next = target.slice(0, nextRevealLength(current.length, target.length));
      setShown(next);
      shownRef.current = next;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active]);

  return active ? shown : target;
}
