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

const NEW_PROJECT = "__new__";

export function NewThreadDialog({ lockedProjectId, projects, providers, onCreateProject, onCreate, onClose }: Props) {
  const available = providers.filter((p) => p.available);
  const [projectId, setProjectId] = useState(lockedProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("New thread");
  const [provider, setProvider] = useState(available[0]?.kind ?? "claude");
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Chosen explicitly from the project select, or forced when none exist. */
  const [addingProject, setAddingProject] = useState(false);
  const needsProject = projects.length === 0 || addingProject;

  /**
   * Adding a project is deliberately not gated on provider availability.
   * Coupling them left users who had not installed a CLI yet with no way to do
   * anything at all — the app looked broken rather than incomplete.
   */
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
      // With no usable provider we stop after the project. The user gets a
      // saved project and clear guidance instead of a disabled button.
      if (available.length > 0) {
        await onCreate(target, title.trim() || "New thread", provider);
      } else {
        onClose();
      }
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
            {projects.length > 0 && (
              <button className="linkish" onClick={() => setAddingProject(false)}>
                Use an existing project instead
              </button>
            )}
          </>
        ) : (
          <select
            value={projectId}
            onChange={(e) => {
              if (e.target.value === NEW_PROJECT) setAddingProject(true);
              else setProjectId(e.target.value);
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PROJECT}>＋ Add another project…</option>
          </select>
        )}

        {available.length > 0 && (
          <input placeholder="Thread title" value={title} onChange={(e) => setTitle(e.target.value)} />
        )}

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
            No agent CLI detected on this machine. You can still add the project now — install and sign in to
            one of the CLIs above, then press Refresh under Providers and start a thread.
          </span>
        )}
        {error && <span className="hint" style={{ color: "var(--destructive-foreground)" }}>{error}</span>}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || (needsProject && !rootPath.trim()) || (!needsProject && available.length === 0)}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : available.length === 0 ? "Add project" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
