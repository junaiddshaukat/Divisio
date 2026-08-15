import { useId, useMemo, useState, type PointerEvent } from "react";
import type { UsageDay } from "@divisio/contracts";
import { formatDayShort, formatTokenCount, formatTokens } from "../tokenFormat.ts";
import {
  CHART,
  areaPath,
  chartBaselineY,
  chartPoints,
  nearestIndex,
  niceMax,
  polylinePath,
} from "../usageChart.ts";

interface Props {
  days: UsageDay[];
}

/**
 * Daily reported tokens as a line + area. Linear between days — no smoothing
 * that would invent usage we did not record.
 */
export function UsageChart({ days }: Props) {
  const gradId = `usage-fill-${useId().replace(/:/g, "")}`;
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => niceMax(Math.max(0, ...days.map((d) => d.tokens))), [days]);
  const points = useMemo(() => chartPoints(days, max), [days, max]);
  const line = useMemo(() => polylinePath(points), [points]);
  const area = useMemo(() => areaPath(points, chartBaselineY()), [points]);
  const ticks = [max, max / 2, 0];
  const innerH = chartBaselineY() - CHART.padT;
  const active = hover !== null ? points[hover] : null;
  const hasSignal = days.some((d) => d.tokens > 0);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * CHART.width;
    setHover(nearestIndex(points, x));
  };

  return (
    <div className="usage-chart">
      <svg
        className="usage-chart-svg"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label="Reported tokens by day"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="usage-chart-fill-top" />
            <stop offset="100%" className="usage-chart-fill-bottom" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => {
          const y = CHART.padT + innerH * (1 - (max <= 0 ? 0 : tick / max));
          return (
            <g key={tick}>
              <line
                className="usage-chart-grid"
                x1={CHART.padL}
                x2={CHART.width - CHART.padR}
                y1={y}
                y2={y}
              />
              <text className="usage-chart-tick" x={CHART.padL - 8} y={y + 3} textAnchor="end">
                {formatTokens(tick)}
              </text>
            </g>
          );
        })}

        {hasSignal && (
          <>
            <path className="usage-chart-area" d={area} fill={`url(#${gradId})`} />
            <path className="usage-chart-line" d={line} />
          </>
        )}

        {active && (
          <>
            <line
              className="usage-chart-rule"
              x1={active.x}
              x2={active.x}
              y1={CHART.padT}
              y2={chartBaselineY()}
            />
            <circle className="usage-chart-dot" cx={active.x} cy={active.y} r="3.5" />
          </>
        )}
      </svg>

      {active && (
        <div
          className="usage-chart-tip"
          style={{ ["--tip-x" as string]: `${Math.min(88, Math.max(12, (active.x / CHART.width) * 100))}%` }}
        >
          <strong>{formatDayShort(active.date)}</strong>
          <span>
            {formatTokens(active.tokens)}
            {active.meteredTurns > 0
              ? ` · ${formatTokenCount(active.meteredTurns)} turn${active.meteredTurns === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}
