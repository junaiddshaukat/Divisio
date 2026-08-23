import type { UsageRangeDays, UsageStats } from "@divisio/contracts";
import { localDateKey, shiftDateKey } from "../store/activity.ts";
import { assembleUsageStats, normalizeUsageRange, type UsageEventRow } from "../store/usage.ts";
import type { EventStore } from "../store/log.ts";
import { scanVendorHomes } from "./scanHomes.ts";
import type { TranscriptUsage } from "@divisio/adapters/usage";

function startOfLocalDayMs(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

function rowsFromTranscripts(records: TranscriptUsage[]): UsageEventRow[] {
  return records.map((rec, i) => ({
    date: localDateKey(new Date(rec.timestampMs)),
    turnId: rec.dedupeKey ?? `${rec.provider}:${rec.sessionId}:${rec.timestampMs}:${i}`,
    provider: rec.provider,
    model: rec.model,
    sessionId: rec.sessionId,
    inputTokens: rec.inputTokens,
    outputTokens: rec.outputTokens,
    cacheReadTokens: rec.cacheReadTokens,
    cacheWriteTokens: rec.cacheWriteTokens,
    totalTokens: rec.totalTokens,
  }));
}

const MACHINE_KINDS = new Set(["claude", "codex", "cursor", "grok", "qwen", "opencode"]);

const CACHE_TTL_MS = 45_000;
const usageCache = new Map<UsageRangeDays, { at: number; stats: UsageStats }>();
const usageInflight = new Map<UsageRangeDays, Promise<UsageStats>>();

export function resetUsageStatsCache(): void {
  usageCache.clear();
  usageInflight.clear();
}

export async function collectUsageStats(store: EventStore, days: unknown): Promise<UsageStats> {
  const rangeDays = normalizeUsageRange(days) as UsageRangeDays;
  const hit = usageCache.get(rangeDays);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.stats;

  const existing = usageInflight.get(rangeDays);
  if (existing) {
    if (hit) return hit.stats;
    return existing;
  }

  const promise = collectUsageStatsOnce(store, rangeDays)
    .then((stats) => {
      usageCache.set(rangeDays, { at: Date.now(), stats });
      return stats;
    })
    .finally(() => {
      if (usageInflight.get(rangeDays) === promise) usageInflight.delete(rangeDays);
    });
  usageInflight.set(rangeDays, promise);
  if (hit) return hit.stats;
  return promise;
}

async function collectUsageStatsOnce(store: EventStore, rangeDays: UsageRangeDays): Promise<UsageStats> {
  const todayKey = localDateKey(new Date());
  const fromKey = shiftDateKey(todayKey, -(rangeDays - 1));
  const untilKey = shiftDateKey(todayKey, 1);
  // Scan first so file I/O can yield; the event log read is CPU-bound.
  const scan = await scanVendorHomes({
    sinceMs: startOfLocalDayMs(fromKey),
    untilMs: startOfLocalDayMs(untilKey),
  });
  const logStats = store.usageStats(rangeDays);

  const scanned = Object.values(scan.files).reduce((sum, n) => sum + n, 0);
  if (scanned === 0 && scan.records.length === 0) {
    return logStats;
  }

  const machine = assembleUsageStats({
    started: [],
    usage: rowsFromTranscripts(scan.records),
    rangeDays,
    todayKey,
  });

  const extra = logStats.providers.filter((p) => !MACHINE_KINDS.has(p.kind));
  const providers = [...machine.providers, ...extra].sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.meteredTurns - a.meteredTurns ||
      b.unmeteredTurns - a.unmeteredTurns ||
      a.kind.localeCompare(b.kind),
  );

  return {
    ...machine,
    providers,
    coverage: {
      source: "machine",
      files: scan.files,
      sessions: machine.totals.sessions,
      appTokens: logStats.totals.tokens,
      appMeteredTurns: logStats.totals.meteredTurns,
    },
  };
}
