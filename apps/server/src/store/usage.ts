import type {
  UsageCoverage,
  UsageDay,
  UsageModelShare,
  UsageProviderShare,
  UsageRangeDays,
  UsageStats,
  UsageTotals,
} from "@divisio/contracts";
import { localDateKey, shiftDateKey } from "./activity.ts";

export const DEFAULT_USAGE_RANGE: UsageRangeDays = 30;

export function normalizeUsageRange(days: unknown): UsageRangeDays {
  return days === 7 || days === 30 || days === 90 ? days : DEFAULT_USAGE_RANGE;
}

export interface UsageEventRow {
  date: string;
  turnId: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface StartedTurnRow {
  date: string;
  turnId: string;
  provider: string;
}

function nonNeg(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Headline tokens: sum the disjoint parts when any are present.
 * `totalTokens` is a fallback for vendors that only send a single counter.
 * Never add `totalTokens` on top of the parts.
 */
export function reportedTokens(u: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const parts =
    nonNeg(u.inputTokens) +
    nonNeg(u.outputTokens) +
    nonNeg(u.cacheReadTokens) +
    nonNeg(u.cacheWriteTokens);
  if (parts > 0) return parts;
  return nonNeg(u.totalTokens);
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function slot(
  map: Map<string, { tokens: number; meteredTurns: number; unmeteredTurns: number }>,
  kind: string,
) {
  let cur = map.get(kind);
  if (!cur) {
    cur = { tokens: 0, meteredTurns: 0, unmeteredTurns: 0 };
    map.set(kind, cur);
  }
  return cur;
}

/**
 * Token counts Divisio recorded on this machine. Dates are local calendar days.
 * Turns with `turn.started` and no `turn.usage` anywhere are unmetered.
 */
export function assembleUsageStats(input: {
  started: StartedTurnRow[];
  usage: UsageEventRow[];
  rangeDays: UsageRangeDays;
  todayKey?: string;
}): UsageStats {
  const todayKey = input.todayKey ?? localDateKey(new Date());
  const from = shiftDateKey(todayKey, -(input.rangeDays - 1));
  const to = todayKey;

  const latestUsageByTurn = new Map<string, UsageEventRow>();
  for (const row of input.usage) latestUsageByTurn.set(row.turnId, row);

  const providerByTurn = new Map<string, string>();
  for (const row of input.started) {
    providerByTurn.set(row.turnId, row.provider || "unknown");
  }

  const usageInRange = new Map<string, UsageEventRow>();
  for (const row of input.usage) {
    if (!inRange(row.date, from, to)) continue;
    usageInRange.set(row.turnId, row);
  }

  const startedInRange = new Map<string, StartedTurnRow>();
  for (const row of input.started) {
    if (!inRange(row.date, from, to)) continue;
    startedInRange.set(row.turnId, row);
  }

  const dayMap = new Map<string, { tokens: number; meteredTurns: number }>();
  const providers = new Map<string, { tokens: number; meteredTurns: number; unmeteredTurns: number }>();
  const models = new Map<string, { provider: string; tokens: number; events: number }>();
  const sessions = new Set<string>();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let tokens = 0;

  for (const u of usageInRange.values()) {
    const count = reportedTokens(u);
    const kind = u.provider || providerByTurn.get(u.turnId) || "unknown";
    const day = dayMap.get(u.date) ?? { tokens: 0, meteredTurns: 0 };
    day.tokens += count;
    day.meteredTurns += 1;
    dayMap.set(u.date, day);

    inputTokens += nonNeg(u.inputTokens);
    outputTokens += nonNeg(u.outputTokens);
    cacheReadTokens += nonNeg(u.cacheReadTokens);
    cacheWriteTokens += nonNeg(u.cacheWriteTokens);
    tokens += count;

    const p = slot(providers, kind);
    p.tokens += count;
    p.meteredTurns += 1;

    if (u.sessionId) sessions.add(u.sessionId);
    if (u.model) {
      const key = `${kind}\0${u.model}`;
      const m = models.get(key) ?? { provider: kind, tokens: 0, events: 0 };
      m.tokens += count;
      m.events += 1;
      models.set(key, m);
    }
  }

  let unmeteredTurns = 0;
  for (const s of startedInRange.values()) {
    if (latestUsageByTurn.has(s.turnId)) continue;
    unmeteredTurns += 1;
    slot(providers, s.provider || "unknown").unmeteredTurns += 1;
  }

  const days: UsageDay[] = [];
  let cursor = from;
  for (let i = 0; i < input.rangeDays; i++) {
    const hit = dayMap.get(cursor);
    days.push({
      date: cursor,
      tokens: hit?.tokens ?? 0,
      meteredTurns: hit?.meteredTurns ?? 0,
    });
    cursor = shiftDateKey(cursor, 1);
  }

  const providerShares: UsageProviderShare[] = [...providers.entries()]
    .map(([kind, v]) => ({ kind, ...v }))
    .sort(
      (a, b) =>
        b.tokens - a.tokens ||
        b.meteredTurns - a.meteredTurns ||
        b.unmeteredTurns - a.unmeteredTurns ||
        a.kind.localeCompare(b.kind),
    );

  const modelShares: UsageModelShare[] = [...models.entries()]
    .map(([key, v]) => ({
      model: key.slice(key.indexOf("\0") + 1),
      provider: v.provider,
      tokens: v.tokens,
      events: v.events,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));

  const totals: UsageTotals = {
    tokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    meteredTurns: usageInRange.size,
    unmeteredTurns,
    sessions: sessions.size,
  };

  const coverage: UsageCoverage = {
    source: "log",
    files: {},
    sessions: sessions.size,
    appTokens: tokens,
    appMeteredTurns: usageInRange.size,
  };

  return {
    rangeDays: input.rangeDays,
    from,
    to,
    days,
    providers: providerShares,
    models: modelShares,
    totals,
    coverage,
  };
}
