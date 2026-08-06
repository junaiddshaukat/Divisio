import type { ProjectView, ThreadView } from "@divisio/contracts";
import type { ConnectionState } from "../client.ts";

interface Props {
  projects: ProjectView[];
  threads: ThreadView[];
  activeId: string | null;
  state: ConnectionState;
  onOpen(threadId: string): void;
  onNew(): void;
  onProviders(): void;
}

/** Relative time, kept terse the way a dense list needs. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function Sidebar({ projects, threads, activeId, state, onOpen, onNew, onProviders }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Divisio</span>
        <button className="icon" onClick={onNew} title="New thread">
          + New
        </button>
      </div>
      <div className="sidebar-body">
        {projects.length === 0 && <div className="section-label">No projects yet</div>}
        {projects.map((project) => {
          const owned = threads.filter((t) => t.projectId === project.id);
          return (
            <div key={project.id}>
              <div className="section-label" title={project.rootPath}>
                {project.name}
              </div>
              {owned.map((thread) => (
                <button
                  key={thread.id}
                  className="row"
                  aria-selected={thread.id === activeId}
                  onClick={() => onOpen(thread.id)}
                >
                  <span className="label">{thread.title}</span>
                  <span className="meta">{ago(thread.updatedAt)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <span className={`dot ${state === "open" ? "ready" : state === "connecting" ? "running" : "error"}`} />
        <span className="meta" style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
          {state === "open" ? "connected" : state}
        </span>
        <button className="linkish" style={{ marginLeft: "auto", fontSize: 11 }} onClick={onProviders}>
          Providers
        </button>
      </div>
    </aside>
  );
}
