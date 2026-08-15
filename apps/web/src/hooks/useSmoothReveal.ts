import { useEffect, useRef, useState } from "react";

/**
 * Reveals streamed text with a light typewriter catch-up so large provider
 * chunks still feel like Claude Code token streaming instead of jumping.
 */
export function useSmoothReveal(target: string, active: boolean): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (!active) {
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
      const lag = target.length - current.length;
      // Catch up faster when far behind so long tool pauses don't stall.
      const step = lag > 80 ? Math.ceil(lag / 6) : lag > 24 ? 4 : 2;
      const next = target.slice(0, current.length + step);
      setShown(next);
      shownRef.current = next;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active]);

  return active ? shown : target;
}
