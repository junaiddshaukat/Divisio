import { useCallback, useEffect, useState } from "react";
import type { FileTreeEntry } from "@divisio/contracts";
import { CodeEditor } from "./CodeEditor.tsx";
import { Button, IconButton, Pill } from "./ui/Button.tsx";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FileIcon, SaveIcon } from "./ui/icons.ts";
import type { FileChangeMarks } from "../lib/changedRanges.ts";

interface Props {
  threadId: string;
  dark: boolean;
  listDir(path: string): Promise<FileTreeEntry[]>;
  readFile(path: string): Promise<{ content: string; binary: boolean; size: number }>;
  writeFile(path: string, content: string): Promise<void>;
  onClose(): void;
  /**
   * File to open, and which lines to highlight in it.
   *
   * Set when the user clicks a changed file in the transcript. Carries a
   * `token` so clicking the same file twice re-opens and re-reveals it — the
   * path alone would look unchanged and do nothing the second time.
   */
  focus?: { path: string; marks: FileChangeMarks; token: number } | null;
}

interface OpenFile {
  path: string;
  content: string;
  saved: string;
  binary: boolean;
}

export function FilePane({
  threadId,
  dark,
  listDir,
  readFile,
  writeFile,
  onClose,
  focus,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, FileTreeEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<OpenFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (path: string) => {
      try {
        const entries = await listDir(path);
        setExpanded((prev) => ({ ...prev, [path]: entries }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [listDir],
  );

  // Reset when the thread changes: a lane-bound thread browses its own worktree.
  useEffect(() => {
    setExpanded({});
    setOpen(new Set());
    setFile(null);
    void load("");
  }, [threadId, load]);

  const toggle = async (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!expanded[path]) await load(path);
    }
    setOpen(next);
  };

  const openFile = useCallback(
    async (path: string) => {
      setError(null);
      try {
        const result = await readFile(path);
        setFile({ path, content: result.content, saved: result.content, binary: result.binary });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [readFile],
  );

  // Open whatever the transcript asked for. Keyed on `token` so re-clicking the
  // same file re-reveals its changes.
  useEffect(() => {
    if (!focus) return;
    void openFile(focus.path);
  }, [focus?.token, focus?.path, openFile]);

  const save = async () => {
    if (!file || file.binary) return;
    setSaving(true);
    setError(null);
    try {
      await writeFile(file.path, file.content);
      setFile((f) => (f ? { ...f, saved: f.content } : f));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty = !!file && file.content !== file.saved;

  const renderLevel = (path: string, depth: number) => {
    const entries = expanded[path];
    if (!entries) return null;
    return entries.map((entry) => (
      <div key={entry.path}>
        <button
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-selected={file?.path === entry.path}
          onClick={() => (entry.kind === "directory" ? void toggle(entry.path) : void openFile(entry.path))}
        >
          <span className="tree-glyph">
            {entry.kind === "directory" ? (
              open.has(entry.path) ? <ChevronDownIcon /> : <ChevronRightIcon />
            ) : null}
          </span>
          {entry.kind === "file" && <FileIcon />}
          <span className="label">{entry.name}</span>
        </button>
        {entry.kind === "directory" && open.has(entry.path) && renderLevel(entry.path, depth + 1)}
      </div>
    ));
  };

  return (
    <section className="file-pane">
      <div className="file-tree">
        <div className="file-pane-head">
          <span className="section-label">Files</span>
          <IconButton label="Close files" icon={<CloseIcon />} size="sm" onClick={onClose} />
        </div>
        <div className="tree-scroll">{renderLevel("", 0)}</div>
      </div>

      <div className="file-editor">
        {file ? (
          <>
            <div className="file-editor-head">
              <code className="label">{file.path}</code>
              {dirty && <Pill tone="warning">unsaved</Pill>}
              <Button
                variant="primary"
                size="sm"
                icon={<SaveIcon />}
                loading={saving}
                disabled={!dirty || file.binary}
                onClick={() => void save()}
              >
                Save
              </Button>
            </div>
            {error && <div className="banner">{error}</div>}
            {file.binary ? (
              <div className="empty">
                <p>This is a binary file, so there is nothing meaningful to show as text.</p>
              </div>
            ) : (
              <CodeEditor
                path={file.path}
                value={file.content}
                dark={dark}
                onChange={(content) => setFile((f) => (f ? { ...f, content } : f))}
                onSave={() => void save()}
                {...(focus && focus.path === file.path ? { changes: focus.marks } : {})}
              />
            )}
          </>
        ) : (
          <div className="empty">
            <p>Select a file to open it. Edits save with ⌘S.</p>
            {error && <span className="hint danger">{error}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
