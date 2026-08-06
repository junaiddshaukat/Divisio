import { useEffect, useRef } from "react";

export interface Bubble {
  kind: "user" | "assistant" | "streaming" | "tools";
  text: string;
  key: string;
  turnId?: string;
  showDiff?: boolean;
}

/**
 * Auto-scroll only while the user is pinned to the bottom. Yanking the view
 * back while someone is reading scrollback is the single most irritating thing
 * a streaming transcript can do.
 */
export function Transcript({
  bubbles,
  onShowDiff,
}: {
  bubbles: Bubble[];
  onShowDiff?(turnId: string): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [bubbles]);

  return (
    <div className="transcript" ref={ref}>
      <div className="thread-inner">
        {bubbles.map((b) => {
          if (b.kind === "user") return <div key={b.key} className="msg-user">{b.text}</div>;
          if (b.kind === "tools") return <div key={b.key} className="tool">tools: {b.text}</div>;
          return (
            <div key={b.key} className={`msg-assistant${b.kind === "streaming" ? " streaming" : ""}`}>
              {b.text}
              {b.showDiff && b.turnId && onShowDiff && (
                <div className="msg-actions">
                  <button className="linkish" onClick={() => onShowDiff(b.turnId!)}>
                    Diff
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
