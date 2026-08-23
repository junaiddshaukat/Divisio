import { memo, useState } from "react";
import type { DiffFileEntry } from "@divisio/contracts";
import { resolvedLineCounts, sumStoredLineCounts } from "./DiffHunkView.tsx";
import { ChevronDownIcon } from "./ui/icons.ts";
import { fileKind, statusLabel } from "../lib/fileKind.ts";

const PREVIEW = 12;

export function DiffLineCounts({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="diff-line-counts">
      <span className="adds">+{adds}</span>
      <span className="dels">−{dels}</span>
    </span>
  );
}

/**
 * What a turn changed, shown under the message that changed it.
 *
 * This is where a user decides whether to trust a turn, so it leads with the
 * count and the totals and makes every row a way into the file. Rows open the
 * file with the agent's edits highlighted rather than a diff view — reviewing
 * a change in the surrounding code is what people actually do next, and the
 * full diff is one click further on.
 *
 * Collapsible because a refactor can touch thirty files, and a wall of paths
 * buries the reply that explains them.
 */
export const FileChangeList = memo(function FileChangeList({
  turnId,
  files,
  onOpen,
  onOpenDiff,
}: {
  turnId: string;
  files: DiffFileEntry[];
  /** Open one file in the editor, focused on what changed. */
  onOpen(turnId: string, path?: string): void;
  /** Open the whole turn as a diff. */
  onOpenDiff?(turnId: string): void;
}) {
  // Collapse long lists by default; a couple of files are worth showing outright.
  const [open, setOpen] = useState(files.length <= 8);

  if (files.length === 0) return null;

  const visible = files.slice(0, PREVIEW);
  const hidden = files.length - visible.length;
  const totals = sumStoredLineCounts(files);

  return (
    <div className={`file-changes${open ? "" : " is-collapsed"}`}>
      <button
        type="button"
        className="file-changes-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDownIcon className="lucide file-changes-chevron" />
        <span className="file-changes-title">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="file-changes-spacer" />
        {totals ? (
          <span className="file-changes-total">
            <span className="adds">+{totals.adds}</span>
            <span className="dels">−{totals.dels}</span>
          </span>
        ) : null}
      </button>

      {open && (
        <div className="file-changes-body">
          {visible.map((file) => {
            const counts = resolvedLineCounts(file);
            const kind = fileKind(file.path);
            const status = statusLabel(file.status);
            return (
              <button
                key={file.path}
                type="button"
                className="file-change-row"
                title={`${file.path} — open with this turn's changes highlighted`}
                onClick={() => onOpen(turnId, file.path)}
              >
                <span
                  className="file-change-ext"
                  style={{ ["--ext-color" as string]: kind.color }}
                  aria-hidden="true"
                >
                  {kind.label}
                </span>
                {/* bdi keeps the RTL truncation from reordering the path text. */}
                <span className="file-change-path">
                  <bdi>{file.path}</bdi>
                </span>
                {status ? (
                  <span className={`file-change-status ${status.tone}`}>{status.text}</span>
                ) : null}
                {counts ? <DiffLineCounts adds={counts.adds} dels={counts.dels} /> : null}
              </button>
            );
          })}
          {hidden > 0 && (
            <button type="button" className="file-change-more" onClick={() => onOpen(turnId)}>
              {hidden} more {hidden === 1 ? "file" : "files"}…
            </button>
          )}
          {onOpenDiff && (
            <button type="button" className="file-change-more" onClick={() => onOpenDiff(turnId)}>
              Review all changes as a diff
            </button>
          )}
        </div>
      )}
    </div>
  );
});
