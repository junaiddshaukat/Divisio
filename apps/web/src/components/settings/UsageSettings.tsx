import { useEffect, useMemo, useState } from "react";
import type { ProviderView, UsageRangeDays, UsageStats } from "@divisio/contracts";
import { compactModelLabel } from "../../providerModels.ts";
import { formatDayShort, formatShare, formatTokenCount, formatTokens } from "../../tokenFormat.ts";
import { ProviderMark } from "../ProviderMark.tsx";
import { UsageChart } from "./UsageChart.tsx";

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
  const machine = stats?.coverage.source === "machine";
  const inputAll = stats
    ? stats.totals.inputTokens + stats.totals.cacheReadTokens + stats.totals.cacheWriteTokens
    : 0;

  const metrics = useMemo(() => {
    if (!stats) return [];
    const t = stats.totals;
    const cacheShare = formatShare(t.cacheReadTokens, inputAll);
    return [
      {
        label: "Cache read",
        value: t.cacheReadTokens,
        hint: cacheShare === "—" ? null : cacheShare,
      },
      {
        label: "Input",
        value: t.inputTokens,
        hint: "Uncached",
      },
      {
        label: "Output",
        value: t.outputTokens,
        hint: null,
      },
      {
        label: "Cache write",
        value: t.cacheWriteTokens,
        hint: null,
      },
    ];
  }, [stats, inputAll]);

  return (
    <div className="settings-section usage-section">
      <p className="usage-note">
        {machine
          ? "Processed tokens from Claude Code and Codex session files on this machine. Cache reads are included. This is not a bill and not a vendor quota."
          : "No Claude or Codex session files found. Showing turns Divisio recorded. This is not a bill."}
        {stats?.coverage.source === "machine" && stats.coverage.appMeteredTurns > 0
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
          <section className="usage-stage" aria-label="Processed tokens">
            <div className="usage-stage-head">
              <div>
                <div className="usage-kicker">{machine ? "Processed tokens" : "Reported tokens"}</div>
                <div className="usage-hero-value">{formatTokens(stats.totals.tokens)}</div>
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
            </div>
            <UsageChart days={stats.days} />
            <div className="usage-days-axis">
              <span>{formatDayShort(stats.from)}</span>
              <span />
              <span>{formatDayShort(stats.to)}</span>
            </div>
          </section>

          {stats.totals.tokens > 0 && (
            <dl className="usage-metrics">
              {metrics.map((m) => (
                <div key={m.label}>
                  <dt>{m.label}</dt>
                  <dd>{formatTokens(m.value)}</dd>
                  {m.hint && <span>{m.hint}</span>}
                </div>
              ))}
            </dl>
          )}

          <section className="usage-block">
            <h4 className="settings-group-title">By agent</h4>
            {stats.providers.length === 0 ? (
              <p className="settings-section-desc">No usage in this window.</p>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Share</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.providers.map((p) => (
                    <tr key={p.kind}>
                      <td>
                        <span className="usage-table-agent">
                          <ProviderMark kind={p.kind} />
                          {labelFor(p.kind)}
                        </span>
                      </td>
                      <td>{formatShare(p.tokens, stats.totals.tokens)}</td>
                      <td>
                        {p.tokens > 0 ? formatTokens(p.tokens) : "—"}
                        {p.unmeteredTurns > 0 ? ` · ${p.unmeteredTurns} unmetered` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {stats.models.length > 0 && (
            <section className="usage-block">
              <h4 className="settings-group-title">By model</h4>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Share</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.models.map((m) => (
                    <tr key={`${m.provider}:${m.model}`}>
                      <td>
                        <span className="usage-table-agent">
                          <ProviderMark kind={m.provider} />
                          {compactModelLabel(m.model)}
                        </span>
                      </td>
                      <td>{formatShare(m.tokens, stats.totals.tokens)}</td>
                      <td>{formatTokens(m.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
