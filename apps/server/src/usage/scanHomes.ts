/**
 * Walk vendor homes and collect token records.
 *
 * Reads counters only. Prompt text is never returned. Results are cached in
 * process memory by file mtime+size so opening Settings twice is cheap.
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

export function resetUsageScanCache(): void {
  fileCache.clear();
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
      else if (entry.isFile() && match(entry.name)) out.push(path);
    }
  }
  await walk(root);
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
  const records: TranscriptUsage[] = [];
  const seenFiles = new Set<string>();
  let files = 0;
  const floor = sinceMs - MTIME_SLACK_MS;

  for (const dir of dirs) {
    const paths = await walkFiles(dir, match);
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

async function scanLooseFiles(
  paths: string[],
  kind: JsonlKind,
  sinceMs: number,
  untilMs: number,
): Promise<{ records: TranscriptUsage[]; files: number }> {
  const records: TranscriptUsage[] = [];
  let files = 0;
  const floor = sinceMs - MTIME_SLACK_MS;
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < floor) continue;
    files += 1;
    const parsed = await recordsForFile(path, st.size, st.mtimeMs, kind);
    for (const rec of parsed) {
      if (rec.timestampMs < sinceMs || rec.timestampMs >= untilMs) continue;
      records.push(rec);
    }
    await Bun.sleep(0);
  }
  return { records, files };
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
  let parsed: TranscriptUsage[];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    parsed = hit.records;
  } else {
    parsed = kind === "cursor" ? readCursorDb(path) : readOpenCodeDb(path);
    fileCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, records: parsed });
  }
  const records = parsed.filter((rec) => rec.timestampMs >= sinceMs && rec.timestampMs < untilMs);
  await Bun.sleep(0);
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

/**
 * Scan vendor homes. `untilMs` should be start of tomorrow local, so today is included.
 */
export async function scanVendorHomes(input: ScanHomesInput): Promise<ScanHomesResult> {
  const skipDefaults = isolated(input);
  const claudeRoots = await existingDirs(
    input.claudeDirs ?? (skipDefaults ? [] : claudeProjectsDirs()),
    ["/projects"],
  );
  const codexRoots = await existingDirs(
    input.codexDirs ?? (skipDefaults ? [] : codexSessionsDirs()),
    ["/sessions"],
  );
  const grokRoots = await existingDirs(input.grokDirs ?? (skipDefaults ? [] : grokSessionDirs()), ["/sessions"]);
  const qwenRoots = await existingDirs(input.qwenDirs ?? (skipDefaults ? [] : qwenUsageDirs()), ["/usage"]);
  const qwenLoose = input.qwenFiles ?? (skipDefaults ? [] : qwenUsageFiles());
  const cursorDbs = input.cursorDbPaths ?? (skipDefaults ? [] : cursorStateDbCandidates());
  const opencodeDbs = input.opencodeDbPaths ?? (skipDefaults ? [] : opencodeDbCandidates());

  const claude = await scanJsonlDir(claudeRoots, "claude", (n) => n.endsWith(".jsonl"), input.sinceMs, input.untilMs);
  const codex = await scanJsonlDir(codexRoots, "codex", (n) => n.endsWith(".jsonl"), input.sinceMs, input.untilMs);
  const grok = await scanJsonlDir(grokRoots, "grok", (n) => n === "updates.jsonl", input.sinceMs, input.untilMs);
  const qwenDir = await scanJsonlDir(
    qwenRoots,
    "qwen",
    (n) => n.startsWith("token-usage") && n.endsWith(".jsonl"),
    input.sinceMs,
    input.untilMs,
  );
  const qwenFile = await scanLooseFiles(qwenLoose, "qwen", input.sinceMs, input.untilMs);
  const cursor = await scanSqlite(cursorDbs, "cursor", input.sinceMs, input.untilMs);
  const opencode = await scanSqlite(opencodeDbs, "opencode", input.sinceMs, input.untilMs);

  const seen = new Set<string>();
  const records: TranscriptUsage[] = [];
  for (const rec of claude.records) pushDedupe(records, rec, seen);
  for (const rec of [...codex.records, ...grok.records, ...qwenDir.records, ...qwenFile.records, ...cursor.records, ...opencode.records]) {
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
