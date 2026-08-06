import { useState } from "react";
import type { ProjectView, ProviderView } from "@divisio/contracts";

interface Props {
  /** Set when creating into a specific lane; the project is then not a choice. */
  lockedProjectId?: string | null;
  projects: ProjectView[];
  providers: ProviderView[];
  onCreateProject(name: string, rootPath: string): Promise<ProjectView | null>;
  onCreate(projectId: string, title: string, provider: string): Promise<void>;
  onClose(): void;
}

export function NewThreadDialog({ lockedProjectId, projects, providers, onCreateProject, onCreate, onClose }: Props) {
  const available = providers.filter((p) => p.available);
  const [projectId, setProjectId] = useState(lockedProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("New thread");
  const [provider, setProvider] = useState(available[0]?.kind ?? "claude");
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsProject = projects.length === 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let target = projectId;
      if (needsProject) {
        const created = await onCreateProject(name.trim() || "project", rootPath.trim());
        if (!created) throw new Error("could not create project");
        target = created.id;
      }
      await onCreate(target, title.trim() || "New thread", provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{needsProject ? "Add a project" : "New thread"}</h2>

        {needsProject ? (
          <>
            <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
            <input
              placeholder="/absolute/path/to/repo"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
            />
            <span className="hint">The agent runs with this directory as its working directory.</span>
          </>
        ) : (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <input placeholder="Thread title" value={title} onChange={(e) => setTitle(e.target.value)} />

        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.kind} value={p.kind} disabled={!p.available}>
              {p.label}
              {p.available ? ` · ${p.tier}${p.version ? ` · ${p.version}` : ""}` : ` · ${p.detail ?? "unavailable"}`}
            </option>
          ))}
        </select>

        {/* Errors name the fix, not just the failure. */}
        {available.length === 0 && (
          <span className="hint">
            No provider CLI detected. Install one and make sure it is authenticated, then reopen this dialog.
          </span>
        )}
        {error && <span className="hint" style={{ color: "var(--destructive-foreground)" }}>{error}</span>}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || (needsProject && !rootPath.trim()) || available.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
