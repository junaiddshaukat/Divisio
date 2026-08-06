import { useMemo, useState } from "react";
import type { LaneView, ProjectView, ThreadView } from "@divisio/contracts";
import type { ConnectionState } from "../client.ts";
import { rollUp, statusOf } from "../status.ts";
import { Button, IconButton } from "./ui/Button.tsx";
import {
  BoardIcon,
  DevicesIcon,
  NewIcon,
  ProjectIcon,
  ProjectOpenIcon,
  ProviderIcon,
  SearchIcon,
  SettingsIcon,
} from "./ui/icons.ts";

interface Props {
  projects: ProjectView[];
  threads: ThreadView[];
  lanes: LaneView[];
  activeId: string | null;
  state: ConnectionState;
  onOpen(threadId: string): void;
  onNew(): void;
  onProviders(): void;
  onSettings(): void;
  onLanes(): void;
  onSearch?(): void;
  laneCount: number;
  view: "thread" | "board";
  onDevices(): void;
  width?: number;
  onResizeWidth?(width: number): void;
}

/** Terse relative time for a dense list ("4h", "1mo"). */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

function StatusDot({ status }: { status: ThreadView["status"] }) {
  const s = statusOf(status);
  return (
    <span
      className={`status-dot dot-${s.tone}${s.pulse ? " is-pulsing" : ""}`}
      role="img"
      aria-label={s.label}
      title={s.label}
    />
  );
}

export function Sidebar({
  projects,
  threads,
  lanes,
  activeId,
  state,
  onOpen,
  onNew,
  onProviders,
  onSettings,
  onLanes,
  onSearch,
  laneCount,
  view,
  onDevices,
  width,
  onResizeWidth,
}: Props) {
  const laneById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  return (
    <aside className="sidebar" style={width ? { width: "100%" } : undefined}>
      <header className="sidebar-head" data-tauri-drag-region>
        <Button variant="secondary" size="sm" className="sidebar-new" icon={<NewIcon />} onClick={onNew}>
          New thread
        </Button>
      </header>

      <nav className="sidebar-body">
        <div className="sidebar-nav">
          {onSearch && (
            <button type="button" className="nav-row" onClick={onSearch}>
              <SearchIcon />
              <span className="nav-label">Search</span>
              <kbd className="nav-kbd">⌘K</kbd>
            </button>
          )}
          <button type="button" className="nav-row" aria-current={view === "board"} onClick={onLanes}>
            <BoardIcon />
            <span className="nav-label">Board</span>
            {laneCount > 0 && <span className="nav-count">{laneCount}</span>}
          </button>
          <button type="button" className="nav-row" onClick={onProviders}>
            <ProviderIcon />
            <span className="nav-label">Providers</span>
          </button>
        </div>

        <div className="sidebar-section-label">Projects</div>

        {projects.length === 0 && (
          <p className="sidebar-empty">
            No projects yet. Press <strong>New thread</strong> to add one.
          </p>
        )}

        {projects.map((project) => {
          const owned = threads.filter((t) => t.projectId === project.id);
          const isCollapsed = collapsed.has(project.id);
          const groupStatus = isCollapsed ? rollUp(owned) : null;
          return (
            <section key={project.id} className="project-group">
              <button
                type="button"
                className="project-head"
                onClick={() => toggle(project.id)}
                title={project.rootPath}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ProjectIcon /> : <ProjectOpenIcon />}
                <span className="project-name">{project.name}</span>
                {groupStatus && groupStatus.priority > 1 && (
                  <span
                    className={`status-dot dot-${groupStatus.tone}${groupStatus.pulse ? " is-pulsing" : ""}`}
                    role="img"
                    aria-label={groupStatus.label}
                    title={groupStatus.label}
                  />
                )}
                <span className="nav-count">{owned.length}</span>
              </button>

              {!isCollapsed &&
                owned.map((thread) => {
                  const lane = thread.laneId ? laneById.get(thread.laneId) : null;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className="thread-row"
                      aria-current={thread.id === activeId && view === "thread"}
                      onClick={() => onOpen(thread.id)}
                      title={lane ? `${thread.provider} · ${lane.branch}` : thread.provider}
                    >
                      <StatusDot status={thread.status} />
                      <span className="thread-title">{thread.title}</span>
                      <time className="thread-time">{ago(thread.updatedAt)}</time>
                    </button>
                  );
                })}
            </section>
          );
        })}
      </nav>

      <footer className="sidebar-foot">
        <button type="button" className="sidebar-foot-btn" onClick={onSettings} title="Settings">
          <SettingsIcon />
          <span className="sidebar-foot-title">Settings</span>
          <span
            className={`sidebar-foot-status${state === "open" ? " is-online" : state === "connecting" ? " is-busy" : " is-offline"}`}
            title={
              state === "open"
                ? "Daemon connected"
                : state === "connecting"
                  ? "Connecting to daemon"
                  : `Daemon ${state}`
            }
          >
            <span
              className={`status-dot dot-${state === "open" ? "ready" : state === "connecting" ? "busy" : "error"}${state === "connecting" ? " is-pulsing" : ""}`}
            />
            {state === "open" ? "Online" : state === "connecting" ? "Connecting" : "Offline"}
          </span>
        </button>
        <IconButton label="Paired devices" icon={<DevicesIcon />} size="sm" onClick={onDevices} />
      </footer>

      {onResizeWidth && (
        <div
          className="panel-resize left-edge"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = width ?? 260;
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => onResizeWidth(startW + (ev.clientX - startX));
            const up = (ev: PointerEvent) => {
              el.releasePointerCapture(ev.pointerId);
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      )}
    </aside>
  );
}
