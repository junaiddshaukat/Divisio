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
  TerminalIcon,
} from "./ui/icons.ts";

/** Right-column surfaces only — terminal lives in the bottom dock. */
export type RightSurface = "picker" | "changes" | "files" | "browser" | null;

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
  onNav(): void;
  onPalette(): void;
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
  onNav,
  onPalette,
  onSurface,
  onCloseSurface,
  onToggleDock,
  onHandoff,
  onHint,
  gitActions,
}: Props) {
  const status = statusOf(thread.status);

  const surfaces = [
    { key: "changes" as const, label: "Changes", icon: <DiffIcon />, badge: dirty },
    { key: "files" as const, label: "Files", icon: <FileIcon />, badge: false },
    { key: "browser" as const, label: "Browser", icon: <BrowserIcon />, badge: false },
  ];

  return (
    <header className="topbar">
      <IconButton label="Menu" icon={<MenuIcon />} size="sm" className="nav-toggle" onClick={onNav} />

      <div className="crumb">
        <span className="crumb-project">{projectName}</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-thread">{thread.title}</span>
      </div>

      <div className="topbar-actions">
        {gitActions}
        <OpenInMenu workdir={workdir} onHint={onHint} />

        <div className="segmented" role="group" aria-label="Workspace surfaces">
          {surfaces.map((s) => (
            <button
              key={s.key}
              className="segment"
              aria-pressed={rightSurface === s.key}
              title={s.label}
              onClick={() => (rightSurface === s.key ? onCloseSurface() : onSurface(s.key))}
            >
              {s.icon}
              <span className="segment-label">{s.label}</span>
              {s.badge && <span className="segment-dot" aria-label="uncommitted changes" />}
            </button>
          ))}
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

        <IconButton label="Search (⌘K)" icon={<SearchIcon />} size="sm" onClick={onPalette} />

        <HandoffMenu
          current={thread.provider}
          providers={providers}
          busy={handoffBusy || busy}
          onHandoff={onHandoff}
        />

<span
          className={`status-chip tone-${status.tone}`}
          title={
            status.tone === "ready"
              ? "Idle — waiting for a prompt"
              : status.label
          }
        >
          <span className={`status-dot dot-${status.tone}${status.pulse ? " is-pulsing" : ""}`} />
          <span className="status-chip-label">{status.label}</span>
        </span>
      </div>
    </header>
  );
}
