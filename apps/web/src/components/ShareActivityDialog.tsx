import { useMemo, useState } from "react";
import type { ActivityStats } from "@divisio/contracts";
import {
  handleFromName,
  peakDayTurns,
  renderShareCardPng,
  shareCaption,
  type ShareCardData,
} from "../shareActivity.ts";
import { PRODUCT_NAME } from "@divisio/shared/brand";
import { BrandMark } from "./BrandMark.tsx";
import { openUrl } from "../platform.ts";
import { Button, IconButton } from "./ui/Button.tsx";
import { CloseIcon, SaveIcon } from "./ui/icons.ts";

interface Props {
  name: string;
  avatar?: string | null;
  stats: ActivityStats;
  onClose(): void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function levelFor(turns: number): 0 | 1 | 2 | 3 | 4 {
  if (turns <= 0) return 0;
  if (turns === 1) return 1;
  if (turns <= 3) return 2;
  if (turns <= 6) return 3;
  return 4;
}

/** Compact heatmap for the share preview (last ~22 weeks). */
function ShareHeatmapPreview({ days }: { days: ActivityStats["days"] }) {
  const first = days[0];
  const pad = first ? new Date(first.date + "T12:00:00").getDay() : 0;
  const cells = [...Array.from({ length: pad }, () => null as (typeof days)[0] | null), ...days];
  const weeks: Array<Array<(typeof days)[0] | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const show = weeks.slice(-22);

  return (
    <div className="share-heatmap" aria-hidden>
      {show.map((week, wi) => (
        <div key={wi} className="share-heatmap-week">
          {Array.from({ length: 7 }, (_, di) => {
            const day = week[di] ?? null;
            if (!day) return <span key={di} className="share-cell is-pad" />;
            return <span key={day.date} className={`share-cell level-${levelFor(day.turns)}`} />;
          })}
        </div>
      ))}
    </div>
  );
}

function XMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

function LinkedInMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
      />
    </svg>
  );
}

function RedditMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.028l2.597.547a1.257 1.257 0 011.246-.889z"
      />
    </svg>
  );
}

/**
 * Share your activity — light card preview + export / social intents.
 */
export function ShareActivityDialog({ name, avatar, stats, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data: ShareCardData = useMemo(
    () => ({
      name,
      handle: handleFromName(name),
      days: stats.days,
      totals: stats.totals,
      peakDayTurns: peakDayTurns(stats.days),
      avatar,
    }),
    [name, avatar, stats],
  );

  const caption = shareCaption(data);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await renderShareCardPng(data);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `divisio-activity-${data.handle.replace("@", "")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const shareNative = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await renderShareCardPng(data);
      const file = new File([blob], "divisio-activity.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Divisio activity", text: caption });
        return;
      }
      await download();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openIntent = (url: string) => {
    void openUrl(url);
  };

  return (
    <div className="dialog-backdrop share-backdrop" onClick={onClose}>
      <div
        className="share-dialog"
        role="dialog"
        aria-label="Share your activity"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="share-dialog-head">
          <h2>Share your activity</h2>
          <IconButton label="Close" icon={<CloseIcon />} size="sm" onClick={onClose} />
        </header>

        <div className="share-card">
          <div className="share-card-top">
            <div className="share-card-identity">
              <div className="share-card-avatar" aria-hidden>
                {avatar ? <img src={avatar} alt="" /> : initials(name)}
              </div>
              <div>
                <div className="share-card-name">{name}</div>
                <div className="share-card-handle">{data.handle}</div>
              </div>
            </div>
            <div className="share-card-brand" aria-hidden>
              <BrandMark size={20} tone="light" />
              {PRODUCT_NAME}
            </div>
          </div>

          <ShareHeatmapPreview days={stats.days} />

          <div className="share-card-stats">
            <div>
              <strong>{formatCompact(stats.totals.turns)}</strong>
              <span>lifetime turns</span>
            </div>
            <div>
              <strong>{formatCompact(data.peakDayTurns)}</strong>
              <span>peak day</span>
            </div>
            <div>
              <strong>{stats.totals.currentStreak}</strong>
              <span>current streak</span>
            </div>
            <div>
              <strong>{stats.totals.longestStreak}</strong>
              <span>longest streak</span>
            </div>
          </div>
        </div>

        {error && <p className="hint danger">{error}</p>}

        <div className="share-actions">
          <button
            type="button"
            className="share-action"
            onClick={() =>
              openIntent(`https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`)
            }
          >
            <span className="share-action-icon">
              <XMark />
            </span>
            X
          </button>
          <button
            type="button"
            className="share-action"
            onClick={() =>
              openIntent(
                `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent("https://divisio.dev")}&summary=${encodeURIComponent(caption)}`,
              )
            }
          >
            <span className="share-action-icon">
              <LinkedInMark />
            </span>
            LinkedIn
          </button>
          <button
            type="button"
            className="share-action"
            onClick={() =>
              openIntent(`https://www.reddit.com/submit?title=${encodeURIComponent(caption)}`)
            }
          >
            <span className="share-action-icon">
              <RedditMark />
            </span>
            Reddit
          </button>
          <button type="button" className="share-action" disabled={busy} onClick={() => void download()}>
            <span className="share-action-icon">
              <SaveIcon />
            </span>
            Save
          </button>
        </div>

        <div className="share-dialog-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void shareNative()}>
            Share image
          </Button>
        </div>
      </div>
    </div>
  );
}
