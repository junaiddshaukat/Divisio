import { useEffect, useRef, useState } from "react";
import type { DiffFileEntry } from "@divisio/contracts";
import { useSmoothReveal } from "../hooks/useSmoothReveal.ts";
import { Markdown } from "./Markdown.tsx";
import { ThinkingStatus } from "./ThinkingStatus.tsx";
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

function AssistantMessage({
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
          <ChangedFilesChip turnId={turnId} files={changedFiles} onOpen={onOpenChanges} />
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
}

function StreamingAssistant({ text }: { text: string }) {
  const revealed = useSmoothReveal(text, true);
  return (
    <div className="msg-assistant streaming">
      <Markdown source={revealed} />
    </div>
  );
}

function ChangedFilesChip({
  turnId,
  files,
  onOpen,
}: {
  turnId: string;
  files: DiffFileEntry[];
  onOpen(turnId: string, path?: string): void;
}) {
  const preview = files.slice(0, 3);
  return (
    <div className="changed-files-card">
      <button className="changed-files-summary" onClick={() => onOpen(turnId)}>
        {files.length} changed file{files.length === 1 ? "" : "s"}
      </button>
      <div className="changed-files-chips">
        {preview.map((f) => (
          <button
            key={f.path}
            className="file-chip"
            title={f.path}
            onClick={() => onOpen(turnId, f.path)}
          >
            <span className={`diff-status status-${f.status}`}>{f.status}</span>
            {basename(f.path)}
          </button>
        ))}
        {files.length > 3 && (
          <button className="file-chip more" onClick={() => onOpen(turnId)}>
            +{files.length - 3} more
          </button>
        )}
      </div>
    </div>
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
