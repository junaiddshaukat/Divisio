import { Database } from "bun:sqlite";
import {
  EVENT_VERSIONS,
  isReadable,
  upcast,
  UpcastError,
  type DomainEvent,
  type EventType,
  type NewEvent,
  type PermissionMode,
  type SessionStatus,
} from "@divisio/contracts";
import { logger } from "@divisio/shared/log";

const log = logger("store");

const SESSION_STATUSES: readonly SessionStatus[] = [
  "connecting", "ready", "running", "awaiting_approval", "stopping", "error", "closed",
];

/**
 * Narrows a status string read back from SQLite.
 *
 * An unrecognised value means the row was written by a newer daemon; treat the
 * session as closed rather than trusting an unknown state machine value.
 */
function toSessionStatus(value: string): SessionStatus {
  if ((SESSION_STATUSES as readonly string[]).includes(value)) return value as SessionStatus;
  log.warn("unknown session status in projection", { value });
  return "closed";
}

/** Unknown modes fall back to the safe end of the range, never to full access. */
function toPermissionMode(value: string): PermissionMode {
  return value === "full_access" ? "full_access" : "supervised";
}

/**
 * Append-only event log plus the projections derived from it.
 *
 * bun:sqlite, not better-sqlite3 — the latter hard-panics the process under Bun
 * (ADR 0008). Projections update in the same transaction as the append, so a
 * client that sees a command result has already seen the resulting state.
 */
export class EventStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // WAL keeps readers from blocking the append path during streaming writes.
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma foreign_keys = on");
    // NORMAL trades an fsync per commit for one per checkpoint. Safe under WAL
    // for everything except OS-level crash, which would cost the last turn.
    this.db.exec("pragma synchronous = NORMAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      create table if not exists events (
        seq       integer primary key autoincrement,
        type      text    not null,
        v         integer not null,
        thread_id text,
        at        text    not null,
        payload   text    not null
      );
      create index if not exists events_thread on events(thread_id, seq);

      create table if not exists projects (
        id text primary key, name text not null,
        root_path text not null, created_at text not null
      );
      create table if not exists threads (
        id text primary key, project_id text not null references projects(id),
        title text not null, provider text not null, status text not null,
        permission_mode text not null default 'supervised',
        created_at text not null, updated_at text not null
      );
      create table if not exists messages (
        turn_id text not null, thread_id text not null references threads(id),
        role text not null, text text not null, at text not null,
        primary key (turn_id, role)
      );
      create table if not exists turn_diffs (
        thread_id text not null, turn_id text not null,
        from_ref text not null, to_ref text not null,
        files_json text not null, primary key (thread_id, turn_id)
      );
      create index if not exists messages_thread on messages(thread_id, at);
    `);
    // Existing DBs created before permission_mode / turn_diffs — additive migrate.
    this.ensureColumn("threads", "permission_mode", "text not null default 'supervised'");
  }

  private ensureColumn(table: string, column: string, ddl: string) {
    const cols = this.db.query<{ name: string }, []>(`pragma table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${ddl}`);
    }
  }

  head(): number {
    const row = this.db.query<{ seq: number | null }, []>("select max(seq) as seq from events").get();
    return row?.seq ?? 0;
  }

  /**
   * Appends events and applies their projections atomically.
   * Returns the stored events with sequence numbers assigned.
   */
  append(events: NewEvent[]): DomainEvent[] {
    if (events.length === 0) return [];
    const at = new Date().toISOString();
    const insert = this.db.prepare(
      "insert into events (type, v, thread_id, at, payload) values (?, ?, ?, ?, ?) returning seq",
    );

    const run = this.db.transaction((batch: NewEvent[]): DomainEvent[] => {
      const out: DomainEvent[] = [];
      for (const e of batch) {
        const v = EVENT_VERSIONS[e.type];
        if (v === undefined) {
          // Strict on write: an unknown type would be unreadable forever.
          throw new Error(`unknown event type: ${e.type}`);
        }
        const row = insert.get(e.type, v, e.threadId, at, JSON.stringify(e.payload)) as { seq: number };
        const stored = {
          seq: row.seq,
          type: e.type,
          v,
          threadId: e.threadId,
          at,
          payload: e.payload,
        } as DomainEvent;
        this.project(stored);
        out.push(stored);
      }
      return out;
    });

    return run(events);
  }

  /** Events after `since`, oldest first. Used for reconnect replay. */
  readSince(since: number, limit = 1000): DomainEvent[] {
    const rows = this.db
      .query<
        { seq: number; type: string; v: number; thread_id: string | null; at: string; payload: string },
        [number, number]
      >("select seq, type, v, thread_id, at, payload from events where seq > ? order by seq limit ?")
      .all(since, limit);
    return rows.flatMap((r) => this.hydrate(r) ?? []);
  }

  private hydrate(r: {
    seq: number;
    type: string;
    v: number;
    thread_id: string | null;
    at: string;
    payload: string;
  }): DomainEvent | null {
    // Tolerant on read: a newer daemon's events must not brick an older one.
    if (!isReadable(r.type, r.v)) {
      log.warn("skipping unreadable event", { seq: r.seq, type: r.type, v: r.v });
      return null;
    }
    try {
      const payload = upcast(r.type, r.v, JSON.parse(r.payload));
      return {
        seq: r.seq,
        type: r.type as EventType,
        v: EVENT_VERSIONS[r.type as EventType],
        threadId: r.thread_id,
        at: r.at,
        payload,
      } as DomainEvent;
    } catch (err) {
      if (err instanceof UpcastError) {
        log.error("upcast failed", { seq: r.seq, type: r.type, v: r.v, err: err.message });
        return null;
      }
      throw err;
    }
  }

  /* ------------------------------ projections ------------------------------ */

  /**
   * Read models are derived and disposable — rebuildable by replaying the log.
   * That property is what makes a projection bug recoverable instead of fatal.
   */
  private project(e: DomainEvent) {
    switch (e.type) {
      case "project.created": {
        const p = e.payload as { projectId: string; name: string; rootPath: string };
        this.db
          .query("insert or replace into projects (id, name, root_path, created_at) values (?, ?, ?, ?)")
          .run(p.projectId, p.name, p.rootPath, e.at);
        break;
      }
      case "thread.created": {
        const p = e.payload as { threadId: string; projectId: string; title: string; provider: string };
        this.db
          .query(
            `insert or replace into threads (id, project_id, title, provider, status, permission_mode, created_at, updated_at)
             values (?, ?, ?, ?, 'ready', 'supervised', ?, ?)`,
          )
          .run(p.threadId, p.projectId, p.title, p.provider, e.at, e.at);
        break;
      }
      case "thread.permission_mode_set": {
        const p = e.payload as { threadId: string; mode: string };
        this.db
          .query("update threads set permission_mode = ?, updated_at = ? where id = ?")
          .run(p.mode, e.at, p.threadId);
        break;
      }
      case "turn.diff_ready": {
        const p = e.payload as {
          threadId: string;
          turnId: string;
          fromRef: string;
          toRef: string;
          files: unknown[];
        };
        this.db
          .query(
            `insert or replace into turn_diffs (thread_id, turn_id, from_ref, to_ref, files_json)
             values (?, ?, ?, ?, ?)`,
          )
          .run(p.threadId, p.turnId, p.fromRef, p.toRef, JSON.stringify(p.files));
        this.touch(p.threadId, e.at);
        break;
      }
      case "turn.message": {
        const p = e.payload as { threadId: string; turnId: string; role: string; text: string };
        this.db
          .query("insert or replace into messages (turn_id, thread_id, role, text, at) values (?, ?, ?, ?, ?)")
          .run(p.turnId, p.threadId, p.role, p.text, e.at);
        this.touch(p.threadId, e.at);
        break;
      }
      case "session.status": {
        const p = e.payload as { threadId: string; status: string };
        this.db.query("update threads set status = ?, updated_at = ? where id = ?").run(p.status, e.at, p.threadId);
        break;
      }
      default:
        if (e.threadId) this.touch(e.threadId, e.at);
    }
  }

  private touch(threadId: string, at: string) {
    this.db.query("update threads set updated_at = ? where id = ?").run(at, threadId);
  }

  /**
   * Drops and rebuilds every projection from the log.
   * The log is truth; this proves it.
   */
  rebuildProjections(): number {
    const run = this.db.transaction(() => {
      this.db.exec("delete from turn_diffs; delete from messages; delete from threads; delete from projects;");
      let n = 0;
      let cursor = 0;
      for (;;) {
        const batch = this.readSince(cursor, 500);
        if (batch.length === 0) break;
        for (const e of batch) {
          this.project(e);
          n++;
          cursor = e.seq;
        }
      }
      return n;
    });
    return run();
  }

  /* -------------------------------- queries -------------------------------- */

  listProjects() {
    return this.db
      .query<{ id: string; name: string; root_path: string; created_at: string }, []>(
        "select id, name, root_path, created_at from projects order by created_at",
      )
      .all()
      .map((r) => ({ id: r.id, name: r.name, rootPath: r.root_path, createdAt: r.created_at }));
  }

  listThreads() {
    return this.db
      .query<
        {
          id: string;
          project_id: string;
          title: string;
          provider: string;
          status: string;
          permission_mode: string;
          updated_at: string;
        },
        []
      >(
        "select id, project_id, title, provider, status, permission_mode, updated_at from threads order by updated_at desc",
      )
      .all()
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        provider: r.provider,
        // Narrowed, not cast to `never`. A `never` here silently poisons every
        // consumer of `.status` — comparisons stop type-checking and the field
        // becomes unusable without anyone noticing.
        status: toSessionStatus(r.status),
        permissionMode: toPermissionMode(r.permission_mode),
        updatedAt: r.updated_at,
      }));
  }

  getTurnDiff(threadId: string, turnId: string) {
    const row = this.db
      .query<
        { from_ref: string; to_ref: string; files_json: string },
        [string, string]
      >("select from_ref, to_ref, files_json from turn_diffs where thread_id = ? and turn_id = ?")
      .get(threadId, turnId);
    if (!row) return null;
    return {
      fromRef: row.from_ref,
      toRef: row.to_ref,
      files: JSON.parse(row.files_json) as Array<{ path: string; status: string }>,
    };
  }

  getThread(threadId: string) {
    return this.listThreads().find((t) => t.id === threadId) ?? null;
  }

  getProject(projectId: string) {
    return this.listProjects().find((p) => p.id === projectId) ?? null;
  }

  listMessages(threadId: string) {
    return this.db
      .query<{ turn_id: string; role: string; text: string; at: string }, [string]>(
        "select turn_id, role, text, at from messages where thread_id = ? order by at, role desc",
      )
      .all(threadId)
      .map((r) => ({ turnId: r.turn_id, role: r.role as "user" | "assistant", text: r.text, at: r.at }));
  }

  close() {
    this.db.close();
  }
}
