import { useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ErrorIcon,
  ExternalIcon,
  FileCodeIcon,
  FileIcon,
  ProviderIcon,
  SearchIcon,
  TerminalIcon,
} from "./ui/icons.ts";

/**
 * Tool activity in the transcript.
 *
 * Agent threads drown in tool noise, so the default is aggressive collapse: a
 * run of entries shows the most recent one plus a count. That is a default
 * rather than a setting, because the person who needs it most is the one who
 * would never find the toggle.
 */

export interface WorkEntry {
  id: string;
  name: string;
  detail?: string;
  status: "running" | "ok" | "failed";
  output?: string;
}

/**
 * Icons follow what the tool *does*, not what it is called. Vendors name the
 * same operation differently, and a reader scanning a thread is looking for
 * "did it read or did it write", never for the vendor's spelling.
 */
function iconFor(name: string) {
  const n = name.toLowerCase();
  if (/bash|shell|exec|run|command|terminal/.test(n)) return <TerminalIcon />;
  if (/read|cat|view|open/.test(n)) return <FileIcon />;
  if (/write|edit|patch|apply|create/.test(n)) return <FileCodeIcon />;
  if (/search|grep|glob|find/.test(n)) return <SearchIcon />;
  if (/fetch|web|http|browse/.test(n)) return <ExternalIcon />;
  return <ProviderIcon />;
}

function StatusGlyph({ status }: { status: WorkEntry["status"] }) {
  if (status === "running") return <span className="work-spinner" aria-label="running" />;
  if (status === "failed") return <ErrorIcon className="lucide work-failed" aria-label="failed" />;
  return <CheckIcon className="lucide work-ok" aria-label="finished" />;
}

function Row({ entry }: { entry: WorkEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = !!entry.output || !!entry.detail;

  return (
    <div className={`work-row${entry.status === "failed" ? " is-failed" : ""}`}>
      <button
        className="work-head"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="work-chevron">
          {expandable ? open ? <ChevronDownIcon /> : <ChevronRightIcon /> : null}
        </span>
        {iconFor(entry.name)}
        <span className="work-name">{entry.name}</span>
        {entry.detail && <span className="work-detail">{entry.detail}</span>}
        <StatusGlyph status={entry.status} />
      </button>
      {open && (entry.output || entry.detail) && (
        <pre className="work-output">{entry.output || entry.detail}</pre>
      )}
    </div>
  );
}

export function WorkEntries({ entries }: { entries: WorkEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  // Anything still running stays visible regardless of the collapse rule: the
  // point of collapsing history is to keep the live edge readable.
  const running = entries.filter((e) => e.status === "running");
  const visible = expanded ? entries : [...entries.slice(-1), ...running.filter((r) => r !== entries.at(-1))];
  const hidden = entries.length - visible.length;

  return (
    <div className="work-group">
      {hidden > 0 && !expanded && (
        <button className="work-more" onClick={() => setExpanded(true)}>
          <ChevronRightIcon />
          Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
        </button>
      )}
      {expanded && entries.length > 1 && (
        <button className="work-more" onClick={() => setExpanded(false)}>
          <ChevronDownIcon />
          Collapse steps
        </button>
      )}
      {visible.map((entry) => (
        <Row key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
