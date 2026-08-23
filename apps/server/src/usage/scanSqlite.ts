/**
 * Read-only SQLite homes (Cursor state.vscdb, OpenCode opencode.db).
 * bun:sqlite stays in the server — adapters stay portable.
 *
 * Cursor's globalStorage DB is often multiple GB of composer transcripts.
 * Never SELECT those blobs into JS, never mmap the file, never scan a
 * database larger than MAX_VENDOR_DB_BYTES — opening Divisio used to RSS 8GB
 * from this path alone.
 */

import { Database } from "bun:sqlite";
import {
  cursorUsageFromFields,
  parseOpenCodeModel,
  parseOpenCodePart,
  type TranscriptUsage,
} from "@divisio/adapters/usage";

/** Skip vendor DBs bigger than this. A full table scan of Cursor's 5GB+ file freezes the daemon. */
export const MAX_VENDOR_DB_BYTES = 128 * 1024 * 1024;

function openReadonly(path: string): Database | null {
  try {
    const db = new Database(path, { readonly: true });
    db.exec("pragma busy_timeout = 5000");
    // Default mmap would show the whole file as process memory in Activity Monitor.
    db.exec("pragma mmap_size = 0");
    db.exec("pragma cache_size = -4000");
    return db;
  } catch {
    return null;
  }
}

function tableNames(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export function readCursorDb(path: string): TranscriptUsage[] {
  const db = openReadonly(path);
  if (!db) return [];
  try {
    if (!tableNames(db).has("cursorDiskKV")) return [];
    // json_extract runs in SQLite. The composer `value` blob never enters JS.
    const rows = db
      .query(
        `SELECT
           key,
           json_extract(value, '$.tokenCount.inputTokens') AS inputTokens,
           json_extract(value, '$.tokenCount.outputTokens') AS outputTokens,
           json_extract(value, '$.tokenCount.input_tokens') AS input_tokens,
           json_extract(value, '$.tokenCount.output_tokens') AS output_tokens,
           json_extract(value, '$.createdAt') AS createdAt,
           json_extract(value, '$.timestamp') AS timestamp,
           coalesce(
             json_extract(value, '$.modelName'),
             json_extract(value, '$.model'),
             json_extract(value, '$.modelInfo.modelName'),
             json_extract(value, '$.modelInfo.model')
           ) AS model,
           json_extract(value, '$.bubbleId') AS bubbleId
         FROM cursorDiskKV
         WHERE key LIKE 'bubbleId:%'`,
      )
      .all() as Array<{
      key: string;
      inputTokens: unknown;
      outputTokens: unknown;
      input_tokens: unknown;
      output_tokens: unknown;
      createdAt: unknown;
      timestamp: unknown;
      model: unknown;
      bubbleId: unknown;
    }>;
    const records: TranscriptUsage[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const rec = cursorUsageFromFields(row.key, {
        inputTokens: row.inputTokens ?? row.input_tokens,
        outputTokens: row.outputTokens ?? row.output_tokens,
        createdAt: row.createdAt,
        timestamp: row.timestamp,
        model: row.model,
        bubbleId: row.bubbleId,
      });
      if (!rec) continue;
      if (rec.dedupeKey) {
        if (seen.has(rec.dedupeKey)) continue;
        seen.add(rec.dedupeKey);
      }
      records.push(rec);
    }
    return records;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function readOpenCodeDb(path: string): TranscriptUsage[] {
  const db = openReadonly(path);
  if (!db) return [];
  try {
    const names = tableNames(db);
    if (!names.has("part")) return [];
    const rows = db
      .query(
        `SELECT id, message_id, session_id, time_created, data
         FROM part
         WHERE data LIKE '%"tokens"%' OR data LIKE '%step-finish%'`,
      )
      .all() as Array<{
      id: string;
      message_id: string;
      session_id: string;
      time_created: number;
      data: string;
    }>;

    const modelByMessage = new Map<string, string>();
    const lookupModel = (messageId: string): string => {
      const hit = modelByMessage.get(messageId);
      if (hit) return hit;
      if (!names.has("message")) {
        modelByMessage.set(messageId, "opencode");
        return "opencode";
      }
      try {
        const msg = db.query("SELECT data FROM message WHERE id = ?").get(messageId) as { data: string } | null;
        const model = msg?.data ? parseOpenCodeModel(JSON.parse(msg.data)) : "opencode";
        modelByMessage.set(messageId, model);
        return model;
      } catch {
        modelByMessage.set(messageId, "opencode");
        return "opencode";
      }
    };

    const records: TranscriptUsage[] = [];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      const rec = parseOpenCodePart(data, {
        id: row.id,
        sessionId: row.session_id,
        timeCreated: row.time_created,
        model: lookupModel(row.message_id),
      });
      if (rec) records.push(rec);
    }
    return records;
  } catch {
    return [];
  } finally {
    db.close();
  }
}
