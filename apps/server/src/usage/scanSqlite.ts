/**
 * Read-only SQLite homes (Cursor state.vscdb, OpenCode opencode.db).
 * bun:sqlite stays in the server — adapters stay portable.
 */

import { Database } from "bun:sqlite";
import { parseCursorBubble, parseOpenCodeModel, parseOpenCodePart, type TranscriptUsage } from "@divisio/adapters/usage";

function openReadonly(path: string): Database | null {
  try {
    const db = new Database(path, { readonly: true });
    db.exec("pragma busy_timeout = 5000");
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
    const rows = db
      .query(
        `SELECT key, value FROM cursorDiskKV
         WHERE key LIKE 'bubbleId:%'
           AND value LIKE '%"tokenCount"%'`,
      )
      .all() as Array<{ key: string; value: string }>;
    const records: TranscriptUsage[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const rec = parseCursorBubble(row.value, row.key);
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
