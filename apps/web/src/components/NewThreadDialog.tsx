import { useEffect, useMemo, useState } from "react";
import type { ProjectView, ProviderView } from "@divisio/contracts";
import { displayLabel, isProviderEnabled, loadProviderPrefs } from "../providerPrefs.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import { Button } from "./ui/Button.tsx";
import { CloseIcon } from "./ui/icons.ts";

interface Props {
  /** When set, create into this project — project picker is hidden. */
  lockedProjectId?: string | null;
  projects: ProjectView[];
  providers: ProviderView[];
  onCreate(projectId: string, title: string, provider: string): Promise<void>;
  onClose(): void;
  /** Open the dedicated Add project dialog when none exist yet. */
  onAddProject?(): void;
}

const NEW_PROJECT = "__new__";

export function NewThreadDialog({
  lockedProjectId,
  projects,
  providers,
  onCreate,
  onClose,
  onAddProject,
}: Props) {
  const [prefs, setPrefs] = useState(loadProviderPrefs);
  const available = providers.filter((p) => p.available && isProviderEnabled(p.kind, prefs));
  const locked = lockedProjectId ? projects.find((p) => p.id === lockedProjectId) : null;
  const [projectId, setProjectId] = useState(lockedProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState(available[0]?.kind ?? "claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setPrefs(loadProviderPrefs());
    window.addEventListener("divisio:provider-prefs", sync);
    return () => window.removeEventListener("divisio:provider-prefs", sync);
  }, []);

  const projectOptions = useMemo(
    () => [
      ...projects.map((p) => ({ value: p.id, label: p.name })),
      ...(onAddProject ? [{ value: NEW_PROJECT, label: "Add another project…" }] : []),
    ],
    [projects, onAddProject],
  );

  const providerOptions = useMemo(
    () =>
      providers
        .filter((p) => isProviderEnabled(p.kind, prefs) || p.kind === provider)
        .map((p) => ({
          value: p.kind,
          label: displayLabel(p.kind, p.label, prefs),
          detail: !isProviderEnabled(p.kind, prefs)
            ? "disabled"
            : p.available
              ? undefined
              : (p.detail ?? "unavailable"),
          disabled: !p.available || !isProviderEnabled(p.kind, prefs),
          icon: <ProviderMark kind={p.kind} accent={prefs[p.kind]?.accent} />,
        })),
    [providers, prefs, provider],
  );

  const submit = async () => {
    if (!locked && !projectId) return;
    setBusy(true);
    setError(null);
    try {
      const target = locked?.id ?? projectId;
      await onCreate(target, title.trim() || "New chat", provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (projects.length === 0 && !locked) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog form-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New chat">
          <header className="form-dialog-head">
            <h2>New chat</h2>
            <button type="button" className="form-dialog-close" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <p className="form-dialog-lead">
            A chat needs a project — the folder the agent works in. Add one first, then come back
            here to start talking.
          </p>
          <div className="actions">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            {onAddProject && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  onClose();
                  onAddProject();
                }}
              >
                Add a project
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog form-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New chat">
        <header className="form-dialog-head">
          <h2>New chat</h2>
          <button type="button" className="form-dialog-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <p className="form-dialog-lead">
          Open a conversation with an agent in a project folder.
        </p>

        <div className="form-fields">
          {locked ? (
            <div className="form-field">
              <span className="form-label">Project</span>
              <div className="form-static">
                <strong>{locked.name}</strong>
                <span className="form-hint">{locked.rootPath}</span>
              </div>
            </div>
          ) : (
            <div className="form-field">
              <label className="form-label" htmlFor="nt-project">
                Project
              </label>
              <MenuSelect
                aria-label="Project"
                value={projectId}
                options={projectOptions}
                onChange={(next) => {
                  if (next === NEW_PROJECT && onAddProject) {
                    onClose();
                    onAddProject();
                    return;
                  }
                  setProjectId(next);
                }}
              />
              <span className="form-hint">Working directory for this chat.</span>
            </div>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="nt-title">
              Title
            </label>
            <input
              id="nt-title"
              className="field"
              placeholder="What are you working on?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && available.length > 0 && void submit()}
            />
            <span className="form-hint">Shown in the sidebar. Rename anytime.</span>
          </div>

          <div className="form-field">
            <span className="form-label">Agent</span>
            <MenuSelect
              aria-label="Agent"
              value={provider}
              options={providerOptions}
              onChange={setProvider}
              disabled={available.length === 0}
            />
            <span className="form-hint">Which CLI runs this chat. Switch later with Hand off.</span>
          </div>
        </div>

        {available.length === 0 && (
          <p className="hint danger">
            No agent is ready. Enable one under Settings → Providers, or install a CLI.
          </p>
        )}
        {error && <p className="hint danger">{error}</p>}

        <div className="actions">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || available.length === 0 || (!locked && !projectId)}
            onClick={() => void submit()}
          >
            {busy ? "Starting…" : "Start chat"}
          </Button>
        </div>
      </div>
    </div>
  );
}
