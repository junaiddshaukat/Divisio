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
  }));
}

const MACHINE_KINDS = new Set(["claude", "codex"]);

export async function collectUsageStats(store: EventStore, days: unknown): Promise<UsageStats> {
  const rangeDays = normalizeUsageRange(days) as UsageRangeDays;
  const logStats = store.usageStats(rangeDays);
  const todayKey = localDateKey(new Date());
  const fromKey = shiftDateKey(todayKey, -(rangeDays - 1));
  const untilKey = shiftDateKey(todayKey, 1);
  const scan = await scanVendorHomes({
    sinceMs: startOfLocalDayMs(fromKey),
    untilMs: startOfLocalDayMs(untilKey),
  });

  const scanned = scan.claudeFiles + scan.codexFiles;
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
      claudeFiles: scan.claudeFiles,
      codexFiles: scan.codexFiles,
      sessions: machine.totals.sessions,
      appTokens: logStats.totals.tokens,
      appMeteredTurns: logStats.totals.meteredTurns,
    },
  };
}
