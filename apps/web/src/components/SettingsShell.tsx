import { useEffect, useRef, useState } from "react";
import type { ActivityStats, PairingStatus, ProviderUpdate, ProviderView, ToolchainStatus, UsageRangeDays, UsageStats } from "@divisio/contracts";
import { Button } from "./ui/Button.tsx";
import {
  AppearanceIcon,
  BranchIcon,
  ChevronLeftIcon,
  ConnectionsIcon,
  KeybindingsIcon,
  ProfileIcon,
  ProviderIcon,
  RefreshIcon,
  SettingsIcon,
  UsageIcon,
} from "./ui/icons.ts";
import { AppearanceSettings } from "./settings/AppearanceSettings.tsx";
import { GeneralSettings } from "./settings/GeneralSettings.tsx";
import { KeybindingsSettings } from "./settings/KeybindingsSettings.tsx";
import { ProfileSettings } from "./settings/ProfileSettings.tsx";
import { ProvidersSettings } from "./settings/ProvidersSettings.tsx";
import { SourceControlSettings } from "./settings/SourceControlSettings.tsx";
import { UsageSettings } from "./settings/UsageSettings.tsx";
import { PairingPanel } from "./PairingPanel.tsx";
import type { Client } from "../client.ts";
import type { ConnectionState } from "../client.ts";

export type SettingsSection =
  | "profile"
  | "usage"
  | "general"
  | "appearance"
  | "providers"
  | "sourceControl"
  | "connections"
  | "keybindings";

type NavIconId =
  | "profile"
  | "usage"
  | "settings"
  | "appearance"
  | "providers"
  | "sourceControl"
  | "connections"
  | "keybindings";

const NAV_GROUPS: { label: string; items: { id: SettingsSection; label: string; icon: NavIconId }[] }[] = [
  {
    label: "Workspace",
    items: [
      { id: "profile", label: "Profile", icon: "profile" },
      { id: "usage", label: "Usage", icon: "usage" },
      { id: "general", label: "General", icon: "settings" },
      { id: "appearance", label: "Appearance", icon: "appearance" },
    ],
  },
  {
    label: "Agents",
    items: [
      { id: "providers", label: "Providers", icon: "providers" },
      { id: "sourceControl", label: "Source Control", icon: "sourceControl" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "connections", label: "Connections", icon: "connections" },
      { id: "keybindings", label: "Keybindings", icon: "keybindings" },
    ],
  },
];

const SECTION_COPY: Record<SettingsSection, string> = {
  profile: "Local coding activity on this machine — turns, streaks, and agents you used.",
  usage: "Tokens this machine recorded — cache included.",
  general: "About Divisio and this window.",
  appearance: "Color mode for the workspace.",
  providers: "Turn agents on or off, see what each CLI actually supports, or add OpenAI-compatible endpoints with your own keys.",
  sourceControl: "Local git and host CLIs on this machine.",
  connections: "Pair another device when the daemon is reachable on the LAN or an overlay network.",
  keybindings: "Keyboard shortcuts for Divisio.",
};

interface Props {
  providers: ProviderView[];
  providerUpdates?: ProviderUpdate[];
  pairing: PairingStatus | null;
  connectionState: ConnectionState;
  client: Client | null;
  initialSection?: SettingsSection;
  onClose(): void;
  onRefreshProviders(): void;
  onEnsurePairing(): Promise<void>;
  onLoadToolchain(): Promise<ToolchainStatus>;
  onLoadActivity(): Promise<ActivityStats>;
  onLoadUsage(days: UsageRangeDays): Promise<UsageStats>;
  onCreateToken(): Promise<{ url: string; expiresAt: string; fingerprint: string | null }>;
  onRevoke(clientId: string): Promise<void>;
  onRevokeAll(): Promise<void>;
  onReplayWelcome?(): void;
  onReconnect?(): void;
}

function NavIcon({ kind }: { kind: NavIconId }) {
  switch (kind) {
    case "profile":
      return <ProfileIcon />;
    case "usage":
      return <UsageIcon />;
    case "appearance":
      return <AppearanceIcon />;
    case "providers":
      return <ProviderIcon />;
    case "sourceControl":
      return <BranchIcon />;
    case "connections":
      return <ConnectionsIcon />;
    case "keybindings":
      return <KeybindingsIcon />;
    default:
      return <SettingsIcon />;
  }
}

/**
 * Full-window Settings workspace: left nav + solid content panel.
 * Replaces the thread/board shell — not a floating dialog.
 */
export function SettingsShell({
  providers,
  providerUpdates = [],
  pairing,
  connectionState,
  client,
  initialSection = "providers",
  onClose,
  onRefreshProviders,
  onEnsurePairing,
  onLoadToolchain,
  onLoadActivity,
  onLoadUsage,
  onCreateToken,
  onRevoke,
  onRevokeAll,
  onReplayWelcome,
  onReconnect,
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [toolchainKey, setToolchainKey] = useState(0);
  const [activityKey, setActivityKey] = useState(0);
  const [usageKey, setUsageKey] = useState(0);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

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

  useEffect(() => {
    if (section === "connections" && connectionState === "open") void onEnsurePairing();
  }, [section, onEnsurePairing, connectionState]);

  const wasConnected = useRef(connectionState === "open");
  useEffect(() => {
    if (connectionState === "open" && !wasConnected.current) {
      setToolchainKey((k) => k + 1);
      setActivityKey((k) => k + 1);
      setUsageKey((k) => k + 1);
    }
    wasConnected.current = connectionState === "open";
  }, [connectionState]);

  const title = NAV_GROUPS.flatMap((g) => g.items).find((n) => n.id === section)?.label ?? "Settings";
  const subtitle = SECTION_COPY[section];

  const headerAction =
    section === "providers" ? (
      <Button variant="secondary" size="sm" icon={<RefreshIcon />} onClick={onRefreshProviders}>
        Refresh
      </Button>
    ) : section === "sourceControl" ? (
      <Button
        variant="secondary"
        size="sm"
        icon={<RefreshIcon />}
        onClick={() => setToolchainKey((k) => k + 1)}
      >
        Refresh
      </Button>
    ) : section === "profile" ? (
      <Button
        variant="secondary"
        size="sm"
        icon={<RefreshIcon />}
        onClick={() => setActivityKey((k) => k + 1)}
      >
        Refresh
      </Button>
    ) : section === "usage" ? (
      <Button
        variant="secondary"
        size="sm"
        icon={<RefreshIcon />}
        onClick={() => setUsageKey((k) => k + 1)}
      >
        Refresh
      </Button>
    ) : null;

  return (
    <div className="settings-shell" role="main" aria-label="Settings">
      <aside className="settings-nav" data-tauri-drag-region>
        <div className="settings-nav-head">
          <button type="button" className="settings-back" onClick={onClose}>
            <ChevronLeftIcon />
            <span>Back to app</span>
          </button>
        </div>
        <nav className="settings-nav-list" aria-label="Settings sections">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="settings-nav-group">
              <div className="settings-nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="settings-nav-item"
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                >
                  <NavIcon kind={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <section className="settings-panel">
        <div className="settings-panel-scroll">
          <div className="settings-panel-inner">
            <header className="settings-panel-head">
              <div className="settings-panel-heading">
                <h1 className="settings-panel-title">{title}</h1>
                <p className="settings-panel-subtitle">{subtitle}</p>
              </div>
              {headerAction}
            </header>

            <div className="settings-panel-body">
              {section === "profile" && (
                <ProfileSettings key={activityKey} load={onLoadActivity} providers={providers} />
              )}

              {section === "usage" && (
                <UsageSettings key={usageKey} load={onLoadUsage} providers={providers} />
              )}

              {section === "general" && (
                <GeneralSettings
                  connectionState={connectionState}
                  onReplayWelcome={onReplayWelcome}
                  onReconnect={onReconnect}
                />
              )}

              {section === "appearance" && <AppearanceSettings />}

              {section === "providers" && (
                <ProvidersSettings
                  providers={providers}
                  updates={providerUpdates}
                  onRefresh={onRefreshProviders}
                  client={client}
                />
              )}

              {section === "sourceControl" && (
                <SourceControlSettings key={toolchainKey} load={onLoadToolchain} />
              )}

              {section === "connections" &&
                (pairing ? (
                  <PairingPanel
                    embedded
                    status={pairing}
                    onCreateToken={onCreateToken}
                    onRevoke={onRevoke}
                    onRevokeAll={onRevokeAll}
                    onClose={onClose}
                  />
                ) : (
                  <p className="settings-section-desc">
                    {connectionState === "open"
                      ? "Loading pairing status…"
                      : "Connect to the local daemon to manage paired devices."}
                  </p>
                ))}

              {section === "keybindings" && <KeybindingsSettings />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
