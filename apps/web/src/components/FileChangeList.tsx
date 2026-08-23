import type { DiffFileEntry } from "@divisio/contracts";
import { resolvedLineCounts } from "./DiffHunkView.tsx";
import { FileIcon } from "./ui/icons.ts";

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
 * Stacked changed-file rows with +n −n, matching the transcript summary
 * in the reference: one file icon, full path, both counts including zeros.
 */
export function FileChangeList({
  turnId,
  files,
  onOpen,
}: {
  turnId: string;
  files: DiffFileEntry[];
  onOpen(turnId: string, path?: string): void;
}) {
  const visible = files.slice(0, PREVIEW);
  const hidden = files.length - visible.length;
  return (
    <div className="file-change-list">
      {visible.map((file) => {
        const counts = resolvedLineCounts(file);
        return (
          <button
            key={file.path}
            type="button"
            className="file-change-row"
            title={file.path}
            onClick={() => onOpen(turnId, file.path)}
          >
            <FileIcon />
            <span className="file-change-path">{file.path}</span>
            {counts ? <DiffLineCounts adds={counts.adds} dels={counts.dels} /> : null}
          </button>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="file-change-more" onClick={() => onOpen(turnId)}>
          {hidden} more
        </button>
      )}
    </div>
  );
}
