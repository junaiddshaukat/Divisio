import { useEffect, useState, type DragEvent } from "react";
import { canPickDirectory, pathFromDroppedFolder, pickDirectory } from "../platform.ts";
import type { ProjectView } from "@divisio/contracts";
import { Button } from "./ui/Button.tsx";
import { AddProjectIcon, CloseIcon, LinkIcon, ProjectIcon } from "./ui/icons.ts";

type Tab = "folder" | "git";

interface Props {
  onCreateLocal(name: string, rootPath: string): Promise<ProjectView | null>;
  onClone(url: string, parentPath: string, name?: string): Promise<ProjectView | null>;
  onClose(): void;
  onAdded?(project: ProjectView): void;
}

function folderNameFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || "project";
}

function folderNameFromUrl(url: string): string {
  return url.replace(/\/$/, "").replace(/\.git$/i, "").split(/[/\\]/).filter(Boolean).pop() || "repository";
}

/**
 * Create project — Folder or Git tabs with labeled fields (not a search palette).
 */
export function AddProjectDialog({ onCreateLocal, onClone, onClose, onAdded }: Props) {
  const [tab, setTab] = useState<Tab>("folder");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [folderName, setFolderName] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const finalClonePath =
    parentPath.trim() && (folderName.trim() || folderNameFromUrl(gitUrl))
      ? `${parentPath.replace(/\/$/, "")}/${folderName.trim() || folderNameFromUrl(gitUrl)}`
      : null;

  const finish = async (project: ProjectView | null) => {
    if (!project) throw new Error("could not add project");
    onAdded?.(project);
    onClose();
  };

  const adoptFolder = (path: string) => {
    setRootPath(path);
    if (!name.trim()) setName(folderNameFromPath(path));
  };

  const browseFolder = async () => {
    const chosen = await pickDirectory();
    if (chosen) adoptFolder(chosen);
  };

  const browseParent = async () => {
    const chosen = await pickDirectory();
    if (chosen) setParentPath(chosen);
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const path = pathFromDroppedFolder(e.dataTransfer);
    if (path) {
      adoptFolder(path);
      return;
    }
    setError(
      canPickDirectory()
        ? "Could not read that folder’s path. Use Browse instead."
        : "Browsers cannot reveal dropped folder paths. Type the path below.",
    );
  };

  const submitFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!rootPath.trim()) throw new Error("Choose a source folder");
      const created = await onCreateLocal(
        name.trim() || folderNameFromPath(rootPath),
        rootPath.trim(),
      );
      await finish(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitGit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!gitUrl.trim()) throw new Error("Enter a repository URL or owner/repo");
      if (!parentPath.trim()) throw new Error("Choose where to clone into");
      const created = await onClone(
        gitUrl.trim(),
        parentPath.trim(),
        folderName.trim() || undefined,
      );
      await finish(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog form-dialog create-project-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Create project"
      >
        <header className="form-dialog-head">
          <h2>Create project</h2>
          <button type="button" className="form-dialog-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="create-tabs" role="tablist" aria-label="Project source">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "folder"}
            className={`create-tab${tab === "folder" ? " is-active" : ""}`}
            onClick={() => {
              setTab("folder");
              setError(null);
            }}
          >
            <ProjectIcon />
            Folder
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "git"}
            className={`create-tab${tab === "git" ? " is-active" : ""}`}
            onClick={() => {
              setTab("git");
              setError(null);
            }}
          >
            <LinkIcon />
            Git
          </button>
        </div>

        {tab === "folder" && (
          <div className="form-fields">
            <div className="form-field">
              <span className="form-label">Source folder</span>
              <button
                type="button"
                className={`folder-drop-zone${dragging ? " is-dragging" : ""}`}
                onClick={() => void browseFolder()}
                onDragOver={onDragOver}
                onDragEnter={onDragOver}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                disabled={busy}
              >
                <AddProjectIcon />
                <span className="folder-drop-zone-title">
                  {rootPath ? folderNameFromPath(rootPath) : "Drop a folder here, or browse"}
                </span>
                {rootPath ? (
                  <span className="folder-drop-zone-path">{rootPath}</span>
                ) : (
                  <span className="folder-drop-zone-hint">
                    The agent uses this directory as its working tree. Nothing is uploaded.
                  </span>
                )}
              </button>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="cp-name">
                Project name
              </label>
              <input
                id="cp-name"
                className="field"
                placeholder="My project"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="form-hint">Shown in the sidebar.</span>
            </div>

            {!canPickDirectory() && (
              <div className="form-field">
                <label className="form-label" htmlFor="cp-path">
                  Folder path
                </label>
                <input
                  id="cp-path"
                  className="field"
                  placeholder="/absolute/path/to/repo"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {tab === "git" && (
          <div className="form-fields">
            <div className="create-need">
              <strong>What you need</strong>
              <ol>
                <li>
                  <strong>Repository</strong> — paste a clone URL or <code>owner/repo</code>.
                </li>
                <li>
                  <strong>Destination</strong> — parent folder where the checkout will live.
                </li>
                <li>
                  <strong>Access</strong> — public repos work immediately; private ones need{" "}
                  <code>git</code> credentials on this machine.
                </li>
              </ol>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="cp-repo">
                Repository
              </label>
              <input
                id="cp-repo"
                className="field"
                placeholder="https://github.com/owner/repo.git"
                value={gitUrl}
                onChange={(e) => {
                  setGitUrl(e.target.value);
                  if (!folderName.trim()) setFolderName(folderNameFromUrl(e.target.value));
                }}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="cp-parent">
                Clone into
              </label>
              <div className="path-row">
                <input
                  id="cp-parent"
                  className="field"
                  placeholder="/Users/you/code"
                  value={parentPath}
                  onChange={(e) => setParentPath(e.target.value)}
                />
                {canPickDirectory() && (
                  <Button variant="ghost" size="sm" onClick={() => void browseParent()}>
                    Browse
                  </Button>
                )}
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="cp-folder">
                Folder name
              </label>
              <input
                id="cp-folder"
                className="field"
                placeholder="repository"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
              />
              {finalClonePath && (
                <span className="form-hint">Final location: {finalClonePath}</span>
              )}
            </div>
          </div>
        )}

        {error && <p className="hint danger">{error}</p>}

        <div className="actions">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={
              busy ||
              (tab === "folder" ? !rootPath.trim() : !gitUrl.trim() || !parentPath.trim())
            }
            onClick={() => void (tab === "folder" ? submitFolder() : submitGit())}
          >
            {tab === "folder" ? "Create project" : "Clone and add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
