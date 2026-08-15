/** Layout math for the Settings → Usage daily chart. Pure; no DOM. */

export const CHART = {
  width: 720,
  height: 228,
  padL: 40,
  padR: 8,
  padT: 16,
  padB: 8,
} as const;

export function chartInnerHeight(): number {
  return CHART.height - CHART.padT - CHART.padB;
}

export function chartBaselineY(): number {
  return CHART.padT + chartInnerHeight();
}

/** Smallest 1/2/5×10^n ceiling above `value`, so Y ticks stay readable. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * exp;
}

export interface ChartPoint {
  date: string;
  tokens: number;
  meteredTurns: number;
  x: number;
  y: number;
}

export function chartPoints(
  days: { date: string; tokens: number; meteredTurns: number }[],
  max: number,
): ChartPoint[] {
  const innerW = CHART.width - CHART.padL - CHART.padR;
  const innerH = chartInnerHeight();
  const n = days.length;
  const denom = max <= 0 ? 1 : max;
  return days.map((d, i) => ({
    date: d.date,
    tokens: d.tokens,
    meteredTurns: d.meteredTurns,
    x: CHART.padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW),
    y: CHART.padT + innerH * (1 - d.tokens / denom),
  }));
}

function coord(n: number): string {
  return n.toFixed(2);
}

export function polylinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${coord(p.x)} ${coord(p.y)}`).join(" ");
}

export function areaPath(points: { x: number; y: number }[], baselineY: number): string {
  if (points.length === 0) return "";
  const last = points[points.length - 1]!;
  const first = points[0]!;
  return `${polylinePath(points)} L${coord(last.x)} ${coord(baselineY)} L${coord(first.x)} ${coord(baselineY)} Z`;
}

export function nearestIndex(points: { x: number }[], x: number): number {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i]!.x - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

export function peakDay<T extends { tokens: number }>(days: T[]): T | null {
  let best: T | null = null;
  for (const d of days) {
    if (d.tokens <= 0) continue;
    if (!best || d.tokens > best.tokens) best = d;
  }
  return best;
}
