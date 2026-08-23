import { memo, useDeferredValue, useEffect, useRef, useState } from "react";
import type { DiffFileEntry } from "@divisio/contracts";
import { useSmoothReveal } from "../hooks/useSmoothReveal.ts";
import { Markdown } from "./Markdown.tsx";
import { ThinkingStatus } from "./ThinkingStatus.tsx";
import { FileChangeList } from "./FileChangeList.tsx";
import { IconButton } from "./ui/Button.tsx";
import { CheckIcon, CopyIcon } from "./ui/icons.ts";
import { WorkEntries, type WorkEntry } from "./WorkEntries.tsx";

export interface Bubble {
  kind: "user" | "assistant" | "streaming" | "work" | "thinking";
  work?: WorkEntry[];
  text: string;
  key: string;
  turnId?: string;
  /** Files changed in this turn's checkpoint, when known. */
  changedFiles?: DiffFileEntry[];
}

/**
 * Auto-scroll only while the user is pinned to the bottom. Yanking the view
 * back while someone is reading scrollback is the single most irritating thing
 * a streaming transcript can do.
 */
export function Transcript({
  bubbles,
  onOpenChanges,
}: {
  bubbles: Bubble[];
  onOpenChanges?(turnId: string, path?: string): void;
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
          // User text stays literal: it is what they typed, and rendering
          // their own markdown would mangle pasted snippets.
          if (b.kind === "user") return <div key={b.key} className="msg-user">{b.text}</div>;
          if (b.kind === "work") return <WorkEntries key={b.key} entries={b.work ?? []} />;
          if (b.kind === "thinking") {
            return (
              <div key={b.key} className="msg-thinking">
                <ThinkingStatus locked={b.text.startsWith("Handing") ? "Handing off" : null} />
              </div>
            );
          }
          if (b.kind === "streaming") {
            return <StreamingAssistant key={b.key} text={b.text} />;
          }
          return (
            <AssistantMessage
              key={b.key}
              text={b.text}
              turnId={b.turnId}
              changedFiles={b.changedFiles}
              onOpenChanges={onOpenChanges}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Memoized per message.
 *
 * The transcript re-renders on every streaming commit — ten times a second
 * while a reply streams. Without this, every completed message in the thread
 * reconciled its whole subtree on each of those commits, so a long thread got
 * measurably slower to stream into than a short one.
 */
const AssistantMessage = memo(function AssistantMessage({
  text,
  turnId,
  changedFiles,
  onOpenChanges,
}: {
  text: string;
  turnId?: string;
  changedFiles?: DiffFileEntry[];
  onOpenChanges?(turnId: string, path?: string): void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msg-assistant-block">
      <div className="msg-assistant">
        <Markdown source={text} />
        {changedFiles && changedFiles.length > 0 && turnId && onOpenChanges && (
          <FileChangeList turnId={turnId} files={changedFiles} onOpen={onOpenChanges} />
        )}
      </div>
      <div className="msg-assistant-meta">
        <IconButton
          label={copied ? "Copied" : "Copy response"}
          icon={copied ? <CheckIcon /> : <CopyIcon />}
          size="sm"
          className="msg-copy-icon"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        />
      </div>
    </div>
  );
});

const StreamingAssistant = memo(function StreamingAssistant({ text }: { text: string }) {
  const revealed = useSmoothReveal(text, true);
  // Markdown parsing is marked, highlighted and DOM-sanitized on every change.
  // Deferring it lets React drop intermediate parses under load, so a fast
  // stream costs one parse per painted frame instead of one per commit.
  const deferred = useDeferredValue(revealed);
  return (
    <div className="msg-assistant streaming">
      <Markdown source={deferred} />
    </div>
  );
});

