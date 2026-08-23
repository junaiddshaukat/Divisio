import { cloneElement, isValidElement, type ReactElement } from "react";
import type { ProviderView, ThreadView } from "@divisio/contracts";
import { statusOf } from "../status.ts";
import { HandoffMenu } from "./HandoffMenu.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
import { IconButton } from "./ui/Button.tsx";
import {
  BrowserIcon,
  DiffIcon,
  FileIcon,
  MenuIcon,
  SearchIcon,
  SidebarIcon,
  TerminalIcon,
} from "./ui/icons.ts";

/** Right-column surfaces only — terminal lives in the bottom dock. */
export type RightSurface = "picker" | "changes" | "files" | "browser" | null;

export function TopbarLead({
  sidebarCollapsed,
  onToggleSidebar,
  onSearch,
  onNav,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onSearch(): void;
  onNav(): void;
}) {
  return (
    <div className="topbar-chrome">
      <IconButton label="Menu" icon={<MenuIcon />} size="sm" className="nav-toggle" onClick={onNav} />
      <IconButton
        label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        icon={<SidebarIcon />}
        size="md"
        className="topbar-lead-btn"
        onClick={onToggleSidebar}
      />
      <IconButton
        label="Search (⌘K)"
        icon={<SearchIcon />}
        size="md"
        className="topbar-lead-btn"
        onClick={onSearch}
      />
    </div>
  );
}

interface Props {
  thread: ThreadView;
  projectName: string;
  providers: ProviderView[];
  rightSurface: RightSurface;
  terminalDock: boolean;
  busy: boolean;
  handoffBusy: boolean;
  dirty: boolean;
  workdir: string | null;
  sidebarCollapsed?: boolean;
  onToggleSidebar?(): void;
  onSearch?(): void;
  onNav(): void;
  onSurface(surface: Exclude<RightSurface, null>): void;
  onCloseSurface(): void;
  onToggleDock(): void;
  onHandoff(provider: string): void;
  onHint?(message: string): void;
  gitActions?: React.ReactNode;
}

/**
 * Thread header. Right-panel surfaces are one segmented control; the terminal
 * is a separate dock toggle under the composer — never a second panel copy.
 *
 * When a surface or the terminal is open, inactive action labels collapse to
 * icons so the breadcrumb stays readable.
 */
export function ThreadTopbar({
  thread,
  projectName,
  providers,
  rightSurface,
  terminalDock,
  busy,
  handoffBusy,
  dirty,
  workdir,
  sidebarCollapsed,
  onToggleSidebar,
  onSearch,
  onNav,
  onSurface,
  onCloseSurface,
  onToggleDock,
  onHandoff,
  onHint,
  gitActions,
}: Props) {
  const status = statusOf(thread.status);
  const compact = rightSurface !== null || terminalDock;

  const surfaces = [
    { key: "changes" as const, label: "Changes", icon: <DiffIcon />, badge: dirty },
    { key: "files" as const, label: "Files", icon: <FileIcon />, badge: false },
    { key: "browser" as const, label: "Browser", icon: <BrowserIcon />, badge: false },
  ];

  const gitSlot =
    gitActions && isValidElement(gitActions)
      ? cloneElement(gitActions as ReactElement<{ compact?: boolean }>, { compact })
      : gitActions;

  return (
    <header className="topbar" data-tauri-drag-region>
      {onToggleSidebar && onSearch ? (
        <TopbarLead
          sidebarCollapsed={!!sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          onSearch={onSearch}
          onNav={onNav}
        />
      ) : (
        <IconButton label="Menu" icon={<MenuIcon />} size="sm" className="nav-toggle" onClick={onNav} />
      )}

      <div className="crumb">
        <span className="crumb-project">{projectName}</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-thread">{thread.title}</span>
      </div>

      <div className={`topbar-actions${compact ? " is-compact" : ""}`}>
        {gitSlot}
        <OpenInMenu workdir={workdir} onHint={onHint} />

        <div className="segmented" role="group" aria-label="Workspace surfaces">
          {surfaces.map((s) => {
            const active = rightSurface === s.key;
            return (
              <button
                key={s.key}
                className="segment"
                aria-pressed={active}
                title={s.label}
                onClick={() => (active ? onCloseSurface() : onSurface(s.key))}
              >
                {s.icon}
                <span className="segment-label">{s.label}</span>
                {s.badge && <span className="segment-dot" aria-label="uncommitted changes" />}
              </button>
            );
          })}
          <button
            type="button"
            className="segment"
            aria-pressed={terminalDock}
            title="Terminal"
            onClick={onToggleDock}
          >
            <TerminalIcon />
            <span className="segment-label">Terminal</span>
          </button>
        </div>

        <HandoffMenu
          current={thread.provider}
          providers={providers}
          turnBusy={busy}
          handoffBusy={handoffBusy}
          compact={compact}
          onHandoff={onHandoff}
        />

        <span className={`status-chip tone-${status.tone}`} title={status.hint}>
          <span className={`status-dot dot-${status.tone}${status.pulse ? " is-pulsing" : ""}`} />
          <span className="status-chip-label">{status.label}</span>
        </span>
      </div>
    </header>
  );
}
