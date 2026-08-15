/**
 * Walk Claude Code / Codex JSONL homes and collect token records.
 *
 * Reads counters only. Prompt text is never returned. Results are cached in
 * process memory by file mtime+size so opening Settings twice is cheap.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  claudeLineMightCarryUsage,
  codexLineMightCarryUsage,
  initialCodexTranscriptState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  type TranscriptUsage,
} from "@divisio/adapters/usage";

const MTIME_SLACK_MS = 48 * 60 * 60 * 1000;

export interface ScanHomesInput {
  /** Inclusive window start (epoch ms). Files older than this minus slack are skipped. */
  sinceMs: number;
  /** Exclusive window end. */
  untilMs: number;
  claudeDirs?: string[];
  codexDirs?: string[];
}

export interface ScanHomesResult {
  records: TranscriptUsage[];
  claudeFiles: number;
  codexFiles: number;
}

interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  records: TranscriptUsage[];
}

const fileCache = new Map<string, FileCacheEntry>();

export function resetUsageScanCache(): void {
  fileCache.clear();
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function claudeProjectsDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  const root = override && override.length > 0 ? override : join(home, ".claude");
  return unique([join(root, "projects"), join(root, ".claude", "projects"), root]);
}

export function codexSessionsDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.CODEX_HOME?.trim();
  const root = override && override.length > 0 ? override : join(home, ".codex");
  return unique([join(root, "sessions"), root]);
}

async function existingDirs(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const dir of candidates) {
    try {
      const st = await stat(dir);
      if (st.isDirectory()) found.push(dir);
    } catch {
      /* missing */
    }
  }
  const nested = found.filter((d) => {
    const norm = d.replace(/\\/g, "/");
    return norm.endsWith("/projects") || norm.endsWith("/sessions");
  });
  return nested.length > 0 ? nested : found;
}

async function walkJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  }
  await walk(root);
  return out;
}

async function readClaudeFile(path: string): Promise<TranscriptUsage[]> {
  const records: TranscriptUsage[] = [];
  const seen = new Set<string>();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!claudeLineMightCarryUsage(line)) continue;
    const rec = parseClaudeTranscriptLine(line);
    if (!rec) continue;
    if (rec.dedupeKey) {
      if (seen.has(rec.dedupeKey)) continue;
      seen.add(rec.dedupeKey);
    }
    records.push(rec);
  }
  return records;
}

async function readCodexFile(path: string): Promise<TranscriptUsage[]> {
  const records: TranscriptUsage[] = [];
  const state = initialCodexTranscriptState();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!codexLineMightCarryUsage(line)) continue;
    const rec = parseCodexTranscriptLine(line, state);
    if (rec) records.push(rec);
  }
  return records;
}

async function recordsForFile(
  path: string,
  size: number,
  mtimeMs: number,
  kind: "claude" | "codex",
): Promise<TranscriptUsage[]> {
  const hit = fileCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.records;
  const records = kind === "claude" ? await readClaudeFile(path) : await readCodexFile(path);
  fileCache.set(path, { mtimeMs, size, records });
  return records;
}

async function scanDir(
  dirs: string[],
  kind: "claude" | "codex",
  sinceMs: number,
  untilMs: number,
): Promise<{ records: TranscriptUsage[]; files: number }> {
  const records: TranscriptUsage[] = [];
  const seenFiles = new Set<string>();
  let files = 0;
  const floor = sinceMs - MTIME_SLACK_MS;

  for (const dir of dirs) {
    const paths = await walkJsonl(dir);
    for (const path of paths) {
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      let st;
      try {
        st = await stat(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < floor) continue;
      files += 1;
      const parsed = await recordsForFile(path, st.size, st.mtimeMs, kind);
      for (const rec of parsed) {
        if (rec.timestampMs < sinceMs || rec.timestampMs >= untilMs) continue;
        records.push(rec);
      }
      await Bun.sleep(0);
    }
  }

  return { records, files };
}

/**
 * Scan vendor homes. `untilMs` should be start of tomorrow local, so today is included.
 */
export async function scanVendorHomes(input: ScanHomesInput): Promise<ScanHomesResult> {
  const claudeRoots = await existingDirs(input.claudeDirs ?? claudeProjectsDirs());
  const codexRoots = await existingDirs(input.codexDirs ?? codexSessionsDirs());
  const claude = await scanDir(claudeRoots, "claude", input.sinceMs, input.untilMs);
  const codex = await scanDir(codexRoots, "codex", input.sinceMs, input.untilMs);

  const seenClaude = new Set<string>();
  const records: TranscriptUsage[] = [];
  for (const rec of claude.records) {
    if (rec.dedupeKey) {
      if (seenClaude.has(rec.dedupeKey)) continue;
      seenClaude.add(rec.dedupeKey);
    }
    records.push(rec);
  }
  records.push(...codex.records);

  return {
    records,
    claudeFiles: claude.files,
    codexFiles: codex.files,
  };
}
