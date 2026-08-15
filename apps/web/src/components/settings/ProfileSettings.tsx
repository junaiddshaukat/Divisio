import { useEffect, useMemo, useState } from "react";
import type { ActivityStats, ProviderView } from "@divisio/contracts";
import { ProviderMark } from "../ProviderMark.tsx";
import { ActivityHeatmap } from "./ActivityHeatmap.tsx";
import { ShareActivityDialog } from "../ShareActivityDialog.tsx";
import { Button } from "../ui/Button.tsx";

const NAME_KEY = "divisio:profile-name";

function loadDisplayName(): string {
  const saved = localStorage.getItem(NAME_KEY)?.trim();
  if (saved) return saved;
  return "Local";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

interface Props {
  load(): Promise<ActivityStats>;
  providers: ProviderView[];
}

/** Settings → Profile: local activity heatmap, streaks, share card. */
export function ProfileSettings({ load, providers }: Props) {
  const [name, setName] = useState(loadDisplayName);
  const [editing, setEditing] = useState(false);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void load()
      .then((s) => {
        if (alive) {
          setStats(s);
          setError(null);
        }
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const commitName = (next: string) => {
    const trimmed = next.trim() || "Local";
    localStorage.setItem(NAME_KEY, trimmed);
    setName(trimmed);
    setEditing(false);
  };

  const labelFor = (kind: string) =>
    providers.find((p) => p.kind === kind)?.label ?? kind;

  const maxProvider = useMemo(
    () => Math.max(1, ...(stats?.providers.map((p) => p.turns) ?? [1])),
    [stats],
  );

  return (
    <div className="settings-section profile-section">
      <div className="profile-identity">
        <div className="profile-avatar" aria-hidden>
          {initials(name)}
        </div>
        <div className="profile-identity-copy">
          {editing ? (
            <input
              className="field profile-name-input"
              autoFocus
              defaultValue={name}
              aria-label="Display name"
              onBlur={(e) => commitName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName((e.target as HTMLInputElement).value);
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <button type="button" className="profile-name" onClick={() => setEditing(true)}>
              {name}
            </button>
          )}
          <span className="profile-identity-meta">On this machine · activity stays local</span>
        </div>
        {stats && !loading && (
          <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
            Share activity
          </Button>
        )}
      </div>

      {loading && <p className="settings-section-desc">Loading activity…</p>}
      {error && <p className="hint danger">{error}</p>}

      {stats && !loading && (
        <>
          <div className="profile-block">
            <div className="profile-block-head">
              <h4 className="settings-group-title">Activity</h4>
              <span className="profile-block-meta">
                {stats.totals.turns} turn{stats.totals.turns === 1 ? "" : "s"} in the last year
              </span>
            </div>
            <ActivityHeatmap days={stats.days} />
          </div>

          <dl className="profile-summary">
            <div>
              <dt>Current streak</dt>
              <dd>
                {stats.totals.currentStreak}
                <span className="profile-summary-unit">day{stats.totals.currentStreak === 1 ? "" : "s"}</span>
              </dd>
            </div>
            <div>
              <dt>Longest streak</dt>
              <dd>
                {stats.totals.longestStreak}
                <span className="profile-summary-unit">day{stats.totals.longestStreak === 1 ? "" : "s"}</span>
              </dd>
            </div>
            <div>
              <dt>Active days</dt>
              <dd>{stats.totals.activeDays}</dd>
            </div>
            <div>
              <dt>Chats</dt>
              <dd>{stats.totals.threads}</dd>
            </div>
            <div>
              <dt>Projects</dt>
              <dd>{stats.totals.projects}</dd>
            </div>
            <div>
              <dt>Files touched</dt>
              <dd>{stats.totals.filesTouched}</dd>
            </div>
          </dl>

          <div className="profile-block">
            <h4 className="settings-group-title">Agents</h4>
            {stats.providers.length === 0 ? (
              <p className="settings-section-desc">No turns yet — start a chat to fill this in.</p>
            ) : (
              <ul className="profile-providers">
                {stats.providers.map((p) => (
                  <li key={p.kind}>
                    <ProviderMark kind={p.kind} />
                    <span className="profile-provider-label">{labelFor(p.kind)}</span>
                    <span className="profile-provider-count">{p.turns}</span>
                    <span
                      className="profile-provider-bar"
                      aria-hidden
                      style={{ ["--share" as string]: `${(p.turns / maxProvider) * 100}%` }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {sharing && stats && (
        <ShareActivityDialog name={name} stats={stats} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}
