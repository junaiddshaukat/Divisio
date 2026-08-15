import type { ActivityDay, ActivityProviderShare, ActivityStats, ActivityTotals } from "@divisio/contracts";

/** Calendar date in the machine's local timezone (YYYY-MM-DD). */
export function localDateKey(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shift a YYYY-MM-DD key by `delta` calendar days (local). */
export function shiftDateKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
}

/**
 * Current streak: consecutive active days ending today, or ending yesterday
 * if today is still empty (so an evening check does not zero the streak).
 * Longest: max consecutive run anywhere in the series.
 */
export function computeStreaks(
  activeDates: Iterable<string>,
  todayKey: string,
): { currentStreak: number; longestStreak: number; activeDays: number } {
  const set = new Set(activeDates);
  const activeDays = set.size;

  let longestStreak = 0;
  if (activeDays > 0) {
    const sorted = [...set].sort();
    let run = 1;
    longestStreak = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (shiftDateKey(sorted[i - 1]!, 1) === sorted[i]) {
        run += 1;
        if (run > longestStreak) longestStreak = run;
      } else {
        run = 1;
      }
    }
  }

  let anchor = todayKey;
  if (!set.has(todayKey)) {
    const yesterday = shiftDateKey(todayKey, -1);
    if (!set.has(yesterday)) {
      return { currentStreak: 0, longestStreak, activeDays };
    }
    anchor = yesterday;
  }

  let currentStreak = 0;
  let cursor = anchor;
  while (set.has(cursor)) {
    currentStreak += 1;
    cursor = shiftDateKey(cursor, -1);
  }

  return { currentStreak, longestStreak, activeDays };
}

/** Build a contiguous day series ending on `endKey`, length `rangeDays`. */
export function buildDaySeries(
  rangeDays: number,
  endKey: string,
  byDay: Map<string, { turns: number; messages: number }>,
): ActivityDay[] {
  const days: ActivityDay[] = [];
  const startKey = shiftDateKey(endKey, -(rangeDays - 1));
  let cursor = startKey;
  for (let i = 0; i < rangeDays; i++) {
    const hit = byDay.get(cursor);
    days.push({
      date: cursor,
      turns: hit?.turns ?? 0,
      messages: hit?.messages ?? 0,
    });
    cursor = shiftDateKey(cursor, 1);
  }
  return days;
}

export const ACTIVITY_RANGE_DAYS = 53 * 7; // 371 — GitHub-like year grid

export function assembleActivityStats(input: {
  turnDays: Array<{ date: string; turns: number }>;
  messageDays: Array<{ date: string; messages: number }>;
  providers: ActivityProviderShare[];
  threads: number;
  projects: number;
  filesTouched: number;
  todayKey?: string;
  rangeDays?: number;
}): ActivityStats {
  const rangeDays = input.rangeDays ?? ACTIVITY_RANGE_DAYS;
  const todayKey = input.todayKey ?? localDateKey(new Date());
  const byDay = new Map<string, { turns: number; messages: number }>();

  for (const row of input.turnDays) {
    const cur = byDay.get(row.date) ?? { turns: 0, messages: 0 };
    cur.turns += row.turns;
    byDay.set(row.date, cur);
  }
  for (const row of input.messageDays) {
    const cur = byDay.get(row.date) ?? { turns: 0, messages: 0 };
    cur.messages += row.messages;
    byDay.set(row.date, cur);
  }

  const days = buildDaySeries(rangeDays, todayKey, byDay);
  const active = days.filter((d) => d.turns > 0).map((d) => d.date);
  const streaks = computeStreaks(active, todayKey);

  const totals: ActivityTotals = {
    turns: days.reduce((n, d) => n + d.turns, 0),
    messages: days.reduce((n, d) => n + d.messages, 0),
    threads: input.threads,
    projects: input.projects,
    filesTouched: input.filesTouched,
    activeDays: streaks.activeDays,
    currentStreak: streaks.currentStreak,
    longestStreak: streaks.longestStreak,
  };

  const providers = [...input.providers].sort((a, b) => b.turns - a.turns);

  return { days, providers, totals, rangeDays };
}
