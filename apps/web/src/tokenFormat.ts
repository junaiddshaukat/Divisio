const INTEGER = new Intl.NumberFormat("en-US");

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function trimScaled(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

/** Compact token count for dense chrome (`1.4M`, `12.4K`). */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trimScaled(value / 1e12)}T`;
  if (abs >= 1e9) return `${trimScaled(value / 1e9)}B`;
  if (abs >= 1e6) return `${trimScaled(value / 1e6)}M`;
  if (abs >= 1e3) return `${trimScaled(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

export function formatTokenCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/** `2026-08-16` → `Aug 16`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  if (!year || !month || !dayOfMonth) return day;
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}
