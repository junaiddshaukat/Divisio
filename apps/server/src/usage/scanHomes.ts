/**
 * Walk vendor homes and collect token records.
 *
 * Reads counters only. Prompt text is never returned. Per-file results are
 * cached by mtime+size; identical windows coalesce and reuse a short TTL so
 * reopening Settings does not walk CLI homes again.
 *
 * When any location override is passed, unspecified kinds are skipped so
 * tests do not touch the real home directories.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  claudeLineMightCarryUsage,
  codexLineMightCarryUsage,
  flushGrokTranscript,
  grokLineMightCarryUsage,
  initialCodexTranscriptState,
  initialGrokTranscriptState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  parseGrokUpdateLine,
  parseQwenUsageLine,
  qwenLineMightCarryUsage,
  type TranscriptUsage,
} from "@divisio/adapters/usage";
import { readCursorDb, readOpenCodeDb } from "./scanSqlite.ts";

const MTIME_SLACK_MS = 48 * 60 * 60 * 1000;

export interface ScanHomesInput {
  /** Inclusive window start (epoch ms). Files older than this minus slack are skipped. */
  sinceMs: number;
  /** Exclusive window end. */
  untilMs: number;
  claudeDirs?: string[];
  codexDirs?: string[];
  grokDirs?: string[];
  qwenDirs?: string[];
  qwenFiles?: string[];
  cursorDbPaths?: string[];
  opencodeDbPaths?: string[];
}

export interface ScanHomesResult {
  records: TranscriptUsage[];
  files: Record<string, number>;
}

interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  records: TranscriptUsage[];
}

const fileCache = new Map<string, FileCacheEntry>();
const WINDOW_TTL_MS = 20_000;
const FILE_CONCURRENCY = 8;

const windowCache = new Map<string, { at: number; result: ScanHomesResult }>();
const windowInflight = new Map<string, Promise<ScanHomesResult>>();

export function resetUsageScanCache(): void {
  fileCache.clear();
  windowCache.clear();
  windowInflight.clear();
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isolated(input: ScanHomesInput): boolean {
  return (
    input.claudeDirs !== undefined ||
    input.codexDirs !== undefined ||
    input.grokDirs !== undefined ||
    input.qwenDirs !== undefined ||
    input.qwenFiles !== undefined ||
    input.cursorDbPaths !== undefined ||
    input.opencodeDbPaths !== undefined
  );
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

export function grokSessionDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.GROK_HOME?.trim() || env.XAI_HOME?.trim();
  const root = override && override.length > 0 ? override : join(home, ".grok");
  return unique([join(root, "sessions")]);
}

export function qwenUsageDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.QWEN_HOME?.trim();
  const root = override && override.length > 0 ? override : join(home, ".qwen");
  return unique([join(root, "usage")]);
}

export function qwenUsageFiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.QWEN_HOME?.trim();
  const root = override && override.length > 0 ? override : join(home, ".qwen");
  return unique([join(root, "usage_record.jsonl")]);
}

export function cursorStateDbCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (env.CURSOR_STATE_DB?.trim()) return [env.CURSOR_STATE_DB.trim()];
  return unique([
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ]);
}

export function opencodeDbCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (env.OPENCODE_DB?.trim()) return [env.OPENCODE_DB.trim()];
  const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return unique([
    join(home, "Library", "Application Support", "opencode", "opencode.db"),
    join(data, "opencode", "opencode.db"),
    join(home, ".local", "share", "opencode", "opencode.db"),
    join(config, "opencode", "opencode.db"),
    join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "opencode", "opencode.db"),
  ]);
}

async function existingDirs(candidates: string[], preferSuffixes: string[]): Promise<string[]> {
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
    return preferSuffixes.some((s) => norm.endsWith(s));
  });
  return nested.length > 0 ? nested : found;
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const path of candidates) {
    try {
      const st = await stat(path);
      if (st.isFile()) return path;
    } catch {
      /* missing */
    }
  }
  return null;
}

async function walkFiles(root: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const batch = pending.splice(0, FILE_CONCURRENCY);
    const nested = await Promise.all(
      batch.map(async (dir) => {
        const subdirs: string[] = [];
        const files: string[] = [];
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return { subdirs, files };
        }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) subdirs.push(path);
          else if (entry.isFile() && match(entry.name)) files.push(path);
        }
        return { subdirs, files };
      }),
    );
    for (const part of nested) {
      out.push(...part.files);
      pending.push(...part.subdirs);
    }
  }
  return out;
}

async function grokModel(sessionDir: string): Promise<string> {
  try {
    const raw = await Bun.file(join(sessionDir, "signals.json")).text();
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.model === "string" && data.model.trim()) return data.model.trim();
    if (typeof data.modelName === "string" && data.modelName.trim()) return data.modelName.trim();
  } catch {
    /* missing */
  }
  return "grok";
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

async function readGrokFile(path: string): Promise<TranscriptUsage[]> {
  const records: TranscriptUsage[] = [];
  const state = initialGrokTranscriptState();
  const model = await grokModel(dirname(path));
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!grokLineMightCarryUsage(line)) continue;
    const rec = parseGrokUpdateLine(line, state, model);
    if (rec) records.push(rec);
  }
  const tail = flushGrokTranscript(state, model);
  if (tail) records.push(tail);
  return records;
}

async function readQwenFile(path: string): Promise<TranscriptUsage[]> {
  const records: TranscriptUsage[] = [];
  const seen = new Set<string>();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!qwenLineMightCarryUsage(line)) continue;
    const rec = parseQwenUsageLine(line);
    if (!rec) continue;
    if (rec.dedupeKey) {
      if (seen.has(rec.dedupeKey)) continue;
      seen.add(rec.dedupeKey);
    }
    records.push(rec);
  }
  return records;
}

type JsonlKind = "claude" | "codex" | "grok" | "qwen";

async function recordsForFile(
  path: string,
  size: number,
  mtimeMs: number,
  kind: JsonlKind,
): Promise<TranscriptUsage[]> {
  const hit = fileCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.records;
  const records =
    kind === "claude"
      ? await readClaudeFile(path)
      : kind === "codex"
        ? await readCodexFile(path)
        : kind === "grok"
          ? await readGrokFile(path)
          : await readQwenFile(path);
  fileCache.set(path, { mtimeMs, size, records });
  return records;
}

async function scanJsonlDir(
  dirs: string[],
  kind: JsonlKind,
  match: (name: string) => boolean,
  sinceMs: number,
  untilMs: number,
): Promise<{ records: TranscriptUsage[]; files: number }> {
  const seenFiles = new Set<string>();
  const allPaths: string[] = [];
  for (const dir of dirs) {
    for (const path of await walkFiles(dir, match)) {
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      allPaths.push(path);
    }
  }

  const floor = sinceMs - MTIME_SLACK_MS;
  const parts = await mapPool(allPaths, FILE_CONCURRENCY, async (path) => {
    let st;
    try {
      st = await stat(path);
    } catch {
      return { records: [] as TranscriptUsage[], counted: 0 };
    }
    if (st.mtimeMs < floor) return { records: [], counted: 0 };
    const parsed = await recordsForFile(path, st.size, st.mtimeMs, kind);
    const records = parsed.filter((rec) => rec.timestampMs >= sinceMs && rec.timestampMs < untilMs);
    return { records, counted: 1 };
  });

  return {
    records: parts.flatMap((p) => p.records),
    files: parts.reduce((n, p) => n + p.counted, 0),
  };
}

async function scanLooseFiles(
  paths: string[],
  kind: JsonlKind,
  sinceMs: number,
  untilMs: number,
): Promise<{ records: TranscriptUsage[]; files: number }> {
  const seen = new Set<string>();
  const uniquePaths = paths.filter((path) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
  const floor = sinceMs - MTIME_SLACK_MS;
  const parts = await mapPool(uniquePaths, FILE_CONCURRENCY, async (path) => {
    let st;
    try {
      st = await stat(path);
    } catch {
      return { records: [] as TranscriptUsage[], counted: 0 };
    }
    if (!st.isFile() || st.mtimeMs < floor) return { records: [], counted: 0 };
    const parsed = await recordsForFile(path, st.size, st.mtimeMs, kind);
    const records = parsed.filter((rec) => rec.timestampMs >= sinceMs && rec.timestampMs < untilMs);
    return { records, counted: 1 };
  });
  return {
    records: parts.flatMap((p) => p.records),
    files: parts.reduce((n, p) => n + p.counted, 0),
  };
}

async function scanSqlite(
  candidates: string[],
  kind: "cursor" | "opencode",
  sinceMs: number,
  untilMs: number,
): Promise<{ records: TranscriptUsage[]; files: number }> {
  const path = await firstExistingFile(candidates);
  if (!path) return { records: [], files: 0 };
  let st;
  try {
    st = await stat(path);
  } catch {
    return { records: [], files: 0 };
  }
  const cacheKey = `${kind}:${path}`;
  const hit = fileCache.get(cacheKey);
  let parsedAll: TranscriptUsage[];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    parsedAll = hit.records;
  } else {
    parsedAll = kind === "cursor" ? readCursorDb(path) : readOpenCodeDb(path);
    fileCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, records: parsedAll });
  }
  const records = parsedAll.filter((rec) => rec.timestampMs >= sinceMs && rec.timestampMs < untilMs);
  return { records, files: 1 };
}

function pushDedupe(into: TranscriptUsage[], rec: TranscriptUsage, seen: Set<string>): void {
  if (rec.dedupeKey) {
    const key = `${rec.provider}:${rec.dedupeKey}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  into.push(rec);
}

function windowKey(input: ScanHomesInput): string {
  return JSON.stringify([
    input.sinceMs,
    input.untilMs,
    input.claudeDirs,
    input.codexDirs,
    input.grokDirs,
    input.qwenDirs,
    input.qwenFiles,
    input.cursorDbPaths,
    input.opencodeDbPaths,
  ]);
}

async function scanVendorHomesUncached(input: ScanHomesInput): Promise<ScanHomesResult> {
  const skipDefaults = isolated(input);
  const [claudeRoots, codexRoots, grokRoots, qwenRoots] = await Promise.all([
    existingDirs(input.claudeDirs ?? (skipDefaults ? [] : claudeProjectsDirs()), ["/projects"]),
    existingDirs(input.codexDirs ?? (skipDefaults ? [] : codexSessionsDirs()), ["/sessions"]),
    existingDirs(input.grokDirs ?? (skipDefaults ? [] : grokSessionDirs()), ["/sessions"]),
    existingDirs(input.qwenDirs ?? (skipDefaults ? [] : qwenUsageDirs()), ["/usage"]),
  ]);
  const qwenLoose = input.qwenFiles ?? (skipDefaults ? [] : qwenUsageFiles());
  const cursorDbs = input.cursorDbPaths ?? (skipDefaults ? [] : cursorStateDbCandidates());
  const opencodeDbs = input.opencodeDbPaths ?? (skipDefaults ? [] : opencodeDbCandidates());

  const [claude, codex, grok, qwenDir, qwenFile, cursor, opencode] = await Promise.all([
    scanJsonlDir(claudeRoots, "claude", (n) => n.endsWith(".jsonl"), input.sinceMs, input.untilMs),
    scanJsonlDir(codexRoots, "codex", (n) => n.endsWith(".jsonl"), input.sinceMs, input.untilMs),
    scanJsonlDir(grokRoots, "grok", (n) => n === "updates.jsonl", input.sinceMs, input.untilMs),
    scanJsonlDir(
      qwenRoots,
      "qwen",
      (n) => n.startsWith("token-usage") && n.endsWith(".jsonl"),
      input.sinceMs,
      input.untilMs,
    ),
    scanLooseFiles(qwenLoose, "qwen", input.sinceMs, input.untilMs),
    scanSqlite(cursorDbs, "cursor", input.sinceMs, input.untilMs),
    scanSqlite(opencodeDbs, "opencode", input.sinceMs, input.untilMs),
  ]);

  const seen = new Set<string>();
  const records: TranscriptUsage[] = [];
  for (const rec of claude.records) pushDedupe(records, rec, seen);
  for (const rec of [
    ...codex.records,
    ...grok.records,
    ...qwenDir.records,
    ...qwenFile.records,
    ...cursor.records,
    ...opencode.records,
  ]) {
    pushDedupe(records, rec, seen);
  }

  return {
    records,
    files: {
      claude: claude.files,
      codex: codex.files,
      grok: grok.files,
      qwen: qwenDir.files + qwenFile.files,
      cursor: cursor.files,
      opencode: opencode.files,
    },
  };
}

/**
 * Scan vendor homes. `untilMs` should be start of tomorrow local, so today is included.
 * Identical windows within WINDOW_TTL_MS share one walk so Settings can reopen immediately.
 */
export async function scanVendorHomes(input: ScanHomesInput): Promise<ScanHomesResult> {
  const key = windowKey(input);
  const now = Date.now();
  const cached = windowCache.get(key);
  if (cached && now - cached.at < WINDOW_TTL_MS) return cached.result;
  const pending = windowInflight.get(key);
  if (pending) return pending;

  const promise = scanVendorHomesUncached(input).then(
    (result) => {
      windowCache.set(key, { at: Date.now(), result });
      windowInflight.delete(key);
      return result;
    },
    (err: unknown) => {
      windowInflight.delete(key);
      throw err;
    },
  );
  windowInflight.set(key, promise);
  return promise;
}
