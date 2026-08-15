import { useEffect, useMemo, useState } from "react";
import type { ProviderView, UsageRangeDays, UsageStats } from "@divisio/contracts";
import { compactModelLabel } from "../../providerModels.ts";
import { formatDayShort, formatTokenCount, formatTokens } from "../../tokenFormat.ts";
import { ProviderMark } from "../ProviderMark.tsx";

interface Props {
  load(days: UsageRangeDays): Promise<UsageStats>;
  providers: ProviderView[];
}

const RANGES: { days: UsageRangeDays; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

function looksLikeMissingCommand(message: string): boolean {
  return /unknown command/i.test(message);
}

function sessionsLabel(n: number): string {
  return n === 1 ? "1 session" : `${formatTokenCount(n)} sessions`;
}

/** Settings → Usage: CLI session files when present, otherwise the event log. */
export function UsageSettings({ load, providers }: Props) {
  const [days, setDays] = useState<UsageRangeDays>(30);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void load(days)
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(
          looksLikeMissingCommand(message)
            ? "This daemon build does not report usage yet. Restart Divisio to pick up the latest daemon."
            : message,
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load, days]);

  const labelFor = (kind: string) => providers.find((p) => p.kind === kind)?.label ?? kind;

  const maxDay = useMemo(
    () => Math.max(1, ...(stats?.days.map((d) => d.tokens) ?? [1])),
    [stats],
  );
  const maxProvider = useMemo(
    () => Math.max(1, ...(stats?.providers.map((p) => p.tokens) ?? [1])),
    [stats],
  );
  const maxModel = useMemo(
    () => Math.max(1, ...(stats?.models.map((m) => m.tokens) ?? [1])),
    [stats],
  );

  const composition = useMemo(() => {
    if (!stats) return [];
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, tokens } = stats.totals;
    const parts = [
      { id: "cache-read", label: "Cache read", value: cacheReadTokens },
      { id: "input", label: "Input", value: inputTokens },
      { id: "output", label: "Output", value: outputTokens },
      { id: "cache-write", label: "Cache write", value: cacheWriteTokens },
    ].filter((p) => p.value > 0);
    if (parts.length > 0) return parts;
    if (tokens > 0) return [{ id: "reported", label: "Reported", value: tokens }];
    return [];
  }, [stats]);

  const compositionTotal = composition.reduce((n, p) => n + p.value, 0);
  const machine = stats?.coverage.source === "machine";

  return (
    <div className="settings-section usage-section">
      <p className="usage-note">
        {machine
          ? "Processed tokens from Claude Code and Codex session files on this machine. Cache reads are included. This is not a bill and not a vendor quota."
          : "No Claude or Codex session files found. Showing turns Divisio recorded. This is not a bill."}
        {machine && stats.coverage.appMeteredTurns > 0
          ? ` Divisio recorded ${formatTokens(stats.coverage.appTokens)} in this window.`
          : ""}
      </p>

      <div className="usage-toolbar">
        <div className="segmented" role="group" aria-label="Usage range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              className="segment"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !stats && <p className="settings-section-desc">Reading CLI session files…</p>}
      {error && <p className="settings-inline-error">{error}</p>}

      {stats && (
        <>
          <section className="usage-card" aria-label="Processed tokens">
            <div className="usage-hero">
              <div>
                <div className="usage-kicker">{machine ? "Processed tokens" : "Reported tokens"}</div>
                <div className="usage-hero-value">{formatTokens(stats.totals.tokens)}</div>
              </div>
              <p className="usage-hero-meta">
                {machine
                  ? `${sessionsLabel(stats.coverage.sessions)} · ${formatTokenCount(stats.totals.meteredTurns)} requests`
                  : stats.totals.meteredTurns === 1
                    ? "1 metered turn"
                    : `${formatTokenCount(stats.totals.meteredTurns)} metered turns`}
                {!machine && stats.totals.unmeteredTurns > 0
                  ? ` · ${formatTokenCount(stats.totals.unmeteredTurns)} unmetered`
                  : ""}
              </p>
            </div>

            <div className="usage-days" role="img" aria-label="Tokens by day">
              {stats.days.map((d) => {
                const pct = d.tokens > 0 ? Math.max(6, (d.tokens / maxDay) * 100) : 0;
                return (
                  <div
                    key={d.date}
                    className="usage-day"
                    title={`${formatDayShort(d.date)} · ${formatTokenCount(d.tokens)} tokens`}
                  >
                    <span
                      className={d.tokens > 0 ? "usage-day-fill" : "usage-day-empty"}
                      style={d.tokens > 0 ? { ["--h" as string]: `${pct}%` } : undefined}
                    />
                  </div>
                );
              })}
            </div>
            <div className="usage-days-axis">
              <span>{formatDayShort(stats.from)}</span>
              <span>{formatDayShort(stats.to)}</span>
            </div>
          </section>

          <section className="usage-block">
            <h4 className="settings-group-title">Composition</h4>
            {composition.length === 0 ? (
              <p className="settings-section-desc">
                {machine
                  ? "No Claude or Codex usage in this window."
                  : "No token reports in this window."}
              </p>
            ) : (
              <>
                <div className="usage-stack" role="img" aria-label="Token composition">
                  {composition.map((part) => (
                    <span
                      key={part.id}
                      className="usage-stack-seg"
                      data-part={part.id}
                      style={{ ["--w" as string]: `${(part.value / compositionTotal) * 100}%` }}
                      title={`${part.label} · ${formatTokenCount(part.value)}`}
                    />
                  ))}
                </div>
                <ul className="usage-legend">
                  {composition.map((part) => (
                    <li key={part.id}>
                      <span className="usage-legend-swatch" data-part={part.id} />
                      <span>{part.label}</span>
                      <span className="usage-legend-value">{formatTokens(part.value)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="usage-block">
            <h4 className="settings-group-title">By agent</h4>
            {stats.providers.length === 0 ? (
              <p className="settings-section-desc">No turns in this window.</p>
            ) : (
              <ul className="usage-providers">
                {stats.providers.map((p) => {
                  const share = p.tokens > 0 ? (p.tokens / maxProvider) * 100 : 0;
                  const meta = [
                    p.tokens > 0 ? formatTokens(p.tokens) : "—",
                    p.meteredTurns > 0 ? `${formatTokenCount(p.meteredTurns)} requests` : null,
                    p.unmeteredTurns > 0 ? `${p.unmeteredTurns} unmetered` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={p.kind}>
                      <ProviderMark kind={p.kind} />
                      <span className="usage-provider-label">{labelFor(p.kind)}</span>
                      <span className="usage-provider-meta">{meta}</span>
                      <span
                        className="usage-provider-bar"
                        aria-hidden
                        style={{ ["--share" as string]: `${share}%` }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {stats.models.length > 0 && (
            <section className="usage-block">
              <h4 className="settings-group-title">By model</h4>
              <ul className="usage-providers">
                {stats.models.map((m) => (
                  <li key={`${m.provider}:${m.model}`}>
                    <ProviderMark kind={m.provider} />
                    <span className="usage-provider-label">{compactModelLabel(m.model)}</span>
                    <span className="usage-provider-meta">{formatTokens(m.tokens)}</span>
                    <span
                      className="usage-provider-bar"
                      aria-hidden
                      style={{ ["--share" as string]: `${(m.tokens / maxModel) * 100}%` }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
