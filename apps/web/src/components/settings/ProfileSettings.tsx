import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityStats, ProviderView } from "@divisio/contracts";
import {
  clearAvatar,
  encodeAvatarFile,
  initials,
  loadAvatar,
  loadDisplayName,
  saveAvatar,
  saveDisplayName,
} from "../../profileIdentity.ts";
import { ProviderMark } from "../ProviderMark.tsx";
import { ActivityHeatmap } from "./ActivityHeatmap.tsx";
import { ShareActivityDialog } from "../ShareActivityDialog.tsx";
import { Button } from "../ui/Button.tsx";
import { CameraIcon, CloseIcon, EditIcon } from "../ui/icons.ts";

interface Props {
  load(): Promise<ActivityStats>;
  providers: ProviderView[];
}

/** Settings → Profile: local activity heatmap, streaks, share card. */
export function ProfileSettings({ load, providers }: Props) {
  const [name, setName] = useState(loadDisplayName);
  const [avatar, setAvatar] = useState<string | null>(loadAvatar);
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

  const labelFor = (kind: string) =>
    providers.find((p) => p.kind === kind)?.label ?? kind;

  const maxProvider = useMemo(
    () => Math.max(1, ...(stats?.providers.map((p) => p.turns) ?? [1])),
    [stats],
  );

  const weekTurns = useMemo(
    () => (stats ? stats.days.slice(-7).reduce((sum, day) => sum + day.turns, 0) : 0),
    [stats],
  );

  return (
    <div className="settings-section profile-section">
      <div className="profile-identity">
        <button
          type="button"
          className="profile-avatar"
          aria-label="Edit profile photo"
          onClick={() => setEditing(true)}
        >
          {avatar ? <img src={avatar} alt="" /> : initials(name)}
          <span className="profile-avatar-edit" aria-hidden>
            <CameraIcon />
          </span>
        </button>
        <div className="profile-identity-copy">
          <p className="profile-name">{name}</p>
          <span className="profile-identity-meta">
            {stats
              ? `On this machine · ${weekTurns} turn${weekTurns === 1 ? "" : "s"} this week`
              : "On this machine · activity stays local"}
          </span>
        </div>
        <div className="profile-identity-actions">
          <Button variant="secondary" size="sm" icon={<EditIcon />} onClick={() => setEditing(true)}>
            Edit
          </Button>
          {stats && (
            <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
              Share activity
            </Button>
          )}
        </div>
      </div>

      {loading && !stats && <p className="settings-section-desc">Loading activity…</p>}
      {error && <p className="hint danger">{error}</p>}

      {stats && (
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

      {editing && (
        <EditProfileDialog
          name={name}
          avatar={avatar}
          onSaved={(nextName, nextAvatar) => {
            setName(nextName);
            setAvatar(nextAvatar);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {sharing && stats && (
        <ShareActivityDialog
          name={name}
          avatar={avatar}
          stats={stats}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}

function EditProfileDialog({
  name,
  avatar,
  onSaved,
  onClose,
}: {
  name: string;
  avatar: string | null;
  onSaved(name: string, avatar: string | null): void;
  onClose(): void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [draftName, setDraftName] = useState(name);
  const [draftAvatar, setDraftAvatar] = useState<string | null>(avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const commit = () => {
    try {
      const saved = saveDisplayName(draftName);
      if (draftAvatar) saveAvatar(draftAvatar);
      else clearAvatar();
      onSaved(saved, draftAvatar);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile.");
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setDraftAvatar(await encodeAvatarFile(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="dialog-backdrop share-backdrop" onClick={onClose}>
      <div
        className="dialog form-dialog profile-edit-dialog"
        role="dialog"
        aria-label="Edit profile"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="form-dialog-head">
          <h2>Edit profile</h2>
          <button type="button" className="form-dialog-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <p className="form-dialog-lead">Name and photo stay on this machine.</p>

        <div className="form-fields">
          <div className="profile-edit-photo">
            <button
              type="button"
              className="profile-edit-avatar"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              aria-label="Choose a photo"
            >
              {draftAvatar ? <img src={draftAvatar} alt="" /> : initials(draftName)}
              <span className="profile-avatar-edit" aria-hidden>
                <CameraIcon />
              </span>
            </button>
            <div className="profile-edit-photo-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                Change photo
              </Button>
              {draftAvatar && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraftAvatar(null)}>
                  Remove
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
          </div>

          <label className="form-field">
            <span className="form-label">Display name</span>
            <input
              className="field"
              value={draftName}
              autoFocus
              aria-label="Display name"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
            />
          </label>
          {error && <p className="hint danger">{error}</p>}
        </div>

        <div className="actions">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={commit}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
