import { useEffect, useMemo, useRef, useState } from "react";
import type { LaneView, ProjectView, ThreadView } from "@divisio/contracts";
import type { ConnectionState } from "../client.ts";
import { confirmDanger } from "../confirm.ts";
import { rollUp, statusOf } from "../status.ts";
import { ProjectContextMenu, type ProjectContextMenuState } from "./ProjectContextMenu.tsx";
import { ThreadContextMenu, type ThreadContextMenuState } from "./ThreadContextMenu.tsx";
import { IconButton } from "./ui/Button.tsx";
import {
  AddProjectIcon,
  BoardIcon,
  ChevronDownIcon,
  DevicesIcon,
  NewThreadIcon,
  ProfileIcon,
  ProjectIcon,
  ProjectOpenIcon,
  ProviderIcon,
  SearchIcon,
  SettingsIcon,
  SidebarHideIcon,
} from "./ui/icons.ts";

interface Props {
  projects: ProjectView[];
  threads: ThreadView[];
  lanes: LaneView[];
  activeId: string | null;
  state: ConnectionState;
  onOpen(threadId: string): void;
  onNew(): void;
  onNewInProject(projectId: string): void;
  onAddProject(): void;
  onProviders(): void;
  onSettings(): void;
  /** Footer connection chip — opens General, where the daemon is explained. */
  onConnection?(): void;
  onProfile(): void;
  onLanes(): void;
  onSearch?(): void;
  laneCount: number;
  view: "thread" | "board";
  onDevices(): void;
  onHideSidebar?(): void;
  width?: number;
  onResizeWidth?(width: number): void;
  onRenameThread?(threadId: string, title: string): void;
  onDeleteThread?(threadId: string): void;
  onRemoveProject?(projectId: string): void;
}

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
  if (s.priority < 2) return null;
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
  onNewInProject,
  onAddProject,
  onProviders,
  onSettings,
  onConnection,
  onProfile,
  onLanes,
  onSearch,
  laneCount,
  view,
  onDevices,
  onHideSidebar,
  width,
  onResizeWidth,
  onRenameThread,
  onDeleteThread,
  onRemoveProject,
}: Props) {
  const laneById = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<ThreadContextMenuState | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  useEffect(() => {
    if (!renamingId) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renamingId]);

  const commitRename = () => {
    if (!renamingId || !onRenameThread) {
      setRenamingId(null);
      return;
    }
    const title = renameDraft.trim();
    const current = threads.find((t) => t.id === renamingId)?.title;
    setRenamingId(null);
    if (!title || title === current) return;
    onRenameThread(renamingId, title);
  };

  const startRename = (threadId: string) => {
    if (!onRenameThread) return;
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    setRenamingId(threadId);
    setRenameDraft(thread.title);
  };

  const requestDelete = (threadId: string) => {
    if (!onDeleteThread) return;
    const thread = threads.find((t) => t.id === threadId);
    const label = thread?.title ?? "this chat";
    void (async () => {
      const ok = await confirmDanger(
        `Delete “${label}”? This removes it from Divisio only — files on disk are not deleted.`,
        "Delete chat",
        { rememberKey: "delete-thread", confirmLabel: "Delete" },
      );
      if (ok) onDeleteThread(threadId);
    })();
  };

  const requestRemoveProject = (projectId: string) => {
    if (!onRemoveProject) return;
    const project = projects.find((p) => p.id === projectId);
    const label = project?.name ?? "this project";
    void (async () => {
      const ok = await confirmDanger(
        `Remove “${label}” from Divisio? Your folder and files stay on disk — only Divisio’s chats for this project are hidden.`,
        "Remove project",
        { rememberKey: "remove-project", confirmLabel: "Remove" },
      );
      if (ok) onRemoveProject(projectId);
    })();
  };

  return (
    <aside className="sidebar" style={width ? { width: "100%" } : undefined}>
      <header className="sidebar-head" data-tauri-drag-region>
        <div className="sidebar-brand-row" ref={menuRef}>
          <button
            type="button"
            className="sidebar-brand"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="sidebar-brand-name">Divisio</span>
            <ChevronDownIcon className="sidebar-brand-chevron" />
          </button>
          <div className="sidebar-brand-actions">
            {onSearch && (
              <IconButton label="Search" icon={<SearchIcon />} size="sm" onClick={onSearch} />
            )}
            <IconButton label="Profile" icon={<ProfileIcon />} size="sm" onClick={onProfile} />
          </div>
          {menuOpen && (
            <ul className="sidebar-brand-menu" role="menu">
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDevices();
                  }}
                >
                  <DevicesIcon />
                  Devices
                </button>
              </li>
              {onHideSidebar && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onHideSidebar();
                    }}
                  >
                    <SidebarHideIcon />
                    Hide sidebar
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </header>

      <nav className="sidebar-body">
        <div className="sidebar-nav">
          <button type="button" className="nav-row nav-row-primary" onClick={onNew}>
            <NewThreadIcon />
            <span className="nav-label">New chat</span>
          </button>
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

        <div className="sidebar-section-head">
          <span className="sidebar-section-label">Projects</span>
          <IconButton label="Add project" icon={<AddProjectIcon />} size="sm" onClick={onAddProject} />
        </div>

        {projects.length === 0 && (
          <p className="sidebar-empty">
            No projects yet. Add a folder, then start a chat.
          </p>
        )}

        {projects.map((project) => {
          const owned = threads.filter((t) => t.projectId === project.id);
          const isCollapsed = collapsed.has(project.id);
          const groupStatus = isCollapsed ? rollUp(owned) : null;
          return (
            <section key={project.id} className="project-group">
              <div className="project-head-row">
                <button
                  type="button"
                  className="project-head"
                  onClick={() => toggle(project.id)}
                  onContextMenu={(e) => {
                    if (!onRemoveProject) return;
                    e.preventDefault();
                    setCtxMenu(null);
                    setProjectMenu({
                      projectId: project.id,
                      name: project.name,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
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
                <IconButton
                  label={`New chat in ${project.name}`}
                  icon={<NewThreadIcon />}
                  size="sm"
                  className="project-new-thread"
                  onClick={() => onNewInProject(project.id)}
                />
              </div>

              {!isCollapsed &&
                owned.map((thread) => {
                    const lane = thread.laneId ? laneById.get(thread.laneId) : null;
                    if (renamingId === thread.id) {
                      return (
                        <div key={thread.id} className="thread-row is-renaming">
                          <StatusDot status={thread.status} />
                          <input
                            ref={renameRef}
                            className="thread-rename-input"
                            value={renameDraft}
                            aria-label="Rename chat"
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenamingId(null);
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      );
                    }
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        className="thread-row"
                        aria-current={thread.id === activeId && view === "thread"}
                        onClick={() => onOpen(thread.id)}
                        onContextMenu={(e) => {
                          if (!onRenameThread && !onDeleteThread) return;
                          e.preventDefault();
                          setProjectMenu(null);
                          setCtxMenu({
                            threadId: thread.id,
                            title: thread.title,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          startRename(thread.id);
                        }}
                        title={thread.title}
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
        <button
          type="button"
          className={`sidebar-foot-status${state === "open" ? " is-online" : state === "connecting" ? " is-busy" : " is-offline"}`}
          title={
            state === "open"
              ? "Local daemon is connected — agents on this machine run through it"
              : state === "connecting"
                ? "Connecting to the local daemon"
                : "Local daemon disconnected — chats will not run until it reconnects"
          }
          aria-label={
            state === "open"
              ? "Connected to local daemon. Open General settings."
              : state === "connecting"
                ? "Connecting to local daemon. Open General settings."
                : "Disconnected from local daemon. Open General settings."
          }
          onClick={() => (onConnection ?? onSettings)()}
        >
          <span
            className={`status-dot dot-${state === "open" ? "ready" : state === "connecting" ? "busy" : "error"}${state === "connecting" ? " is-pulsing" : ""}`}
            aria-hidden
          />
          {state === "open" ? "Connected" : state === "connecting" ? "Connecting" : "Disconnected"}
        </button>
        <IconButton
          label="Settings"
          icon={<SettingsIcon />}
          size="sm"
          className="sidebar-foot-settings"
          onClick={onSettings}
        />
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

      <ThreadContextMenu
        menu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={startRename}
        onDelete={requestDelete}
      />
      <ProjectContextMenu
        menu={projectMenu}
        onClose={() => setProjectMenu(null)}
        onRemove={requestRemoveProject}
      />
    </aside>
  );
}
