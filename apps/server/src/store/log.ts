import { Database } from "bun:sqlite";
import {
  EVENT_VERSIONS,
  isReadable,
  upcast,
  UpcastError,
  type ActivityStats,
  type DomainEvent,
  type EventType,
  type NewEvent,
  type LaneStatus,
  type LaneView,
  type PermissionMode,
  type SessionStatus,
  type ThreadView,
} from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { assembleActivityStats, localDateKey } from "./activity.ts";

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

interface LaneRow {
  id: string;
  project_id: string;
  title: string;
  branch: string;
  base_sha: string;
  root: string;
  port: number;
  status: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

const LANE_STATUSES: readonly LaneStatus[] = ["preparing", "ready", "error", "archived"];

function toLaneStatus(value: string): LaneStatus {
  return (LANE_STATUSES as readonly string[]).includes(value) ? (value as LaneStatus) : "error";
}

function toLaneView(r: LaneRow): LaneView {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    branch: r.branch,
    baseSha: r.base_sha,
    root: r.root,
    port: r.port,
    status: toLaneStatus(r.status),
    detail: r.detail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
      create table if not exists lanes (
        id text primary key, project_id text not null references projects(id),
        title text not null, branch text not null, base_sha text not null,
        root text not null, port integer not null, status text not null,
        detail text, created_at text not null, updated_at text not null
      );
      create index if not exists lanes_project on lanes(project_id, updated_at);

      create table if not exists turn_diffs (
        thread_id text not null, turn_id text not null,
        from_ref text not null, to_ref text not null,
        files_json text not null, primary key (thread_id, turn_id)
      );
      create index if not exists messages_thread on messages(thread_id, at);
    `);
    // Existing DBs created before permission_mode / turn_diffs — additive migrate.
    this.ensureColumn("threads", "permission_mode", "text not null default 'supervised'");
    this.ensureColumn("threads", "lane_id", "text");
    this.ensureColumn("threads", "model", "text");
    this.ensureColumn("threads", "vendor_session_id", "text");
    this.ensureColumn("threads", "deleted_at", "text");
    this.ensureColumn("projects", "deleted_at", "text");
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
      case "project.removed": {
        const p = e.payload as { projectId: string };
        this.db.query("update projects set deleted_at = ? where id = ?").run(e.at, p.projectId);
        // Hide chats for this project; leave lanes/worktrees on disk alone.
        this.db
          .query(
            "update threads set deleted_at = ?, updated_at = ? where project_id = ? and deleted_at is null",
          )
          .run(e.at, e.at, p.projectId);
        break;
      }
      case "thread.created": {
        const p = e.payload as {
          threadId: string;
          projectId: string;
          title: string;
          provider: string;
          laneId?: string;
        };
        this.db
          .query(
            `insert or replace into threads (id, project_id, title, provider, status, permission_mode, lane_id, created_at, updated_at)
             values (?, ?, ?, ?, 'ready', 'supervised', ?, ?, ?)`,
          )
          .run(p.threadId, p.projectId, p.title, p.provider, p.laneId ?? null, e.at, e.at);
        break;
      }
      case "thread.renamed": {
        const p = e.payload as { threadId: string; title: string };
        this.db
          .query("update threads set title = ?, updated_at = ? where id = ? and deleted_at is null")
          .run(p.title, e.at, p.threadId);
        break;
      }
      case "thread.deleted": {
        const p = e.payload as { threadId: string };
        this.db
          .query("update threads set deleted_at = ?, updated_at = ? where id = ?")
          .run(e.at, e.at, p.threadId);
        break;
      }
      case "thread.permission_mode_set": {
        const p = e.payload as { threadId: string; mode: string };
        this.db
          .query("update threads set permission_mode = ?, updated_at = ? where id = ?")
          .run(p.mode, e.at, p.threadId);
        break;
      }
      case "thread.provider_set": {
        const p = e.payload as { threadId: string; provider: string; model: string | null };
        // Clear the vendor session when the CLI changes — the id is not
        // meaningful to the next adapter. Model-only updates keep it.
        this.db
          .query(
            `update threads set
               vendor_session_id = case when provider = ? then vendor_session_id else null end,
               provider = ?, model = ?, updated_at = ?
             where id = ?`,
          )
          .run(p.provider, p.provider, p.model, e.at, p.threadId);
        break;
      }
      case "thread.vendor_session_set": {
        const p = e.payload as { threadId: string; nativeId: string };
        this.db
          .query("update threads set vendor_session_id = ?, updated_at = ? where id = ?")
          .run(p.nativeId, e.at, p.threadId);
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
      case "lane.created": {
        const p = e.payload as {
          laneId: string; projectId: string; title: string; branch: string;
          baseSha: string; root: string; port: number;
        };
        this.db
          .query(
            `insert or replace into lanes
             (id, project_id, title, branch, base_sha, root, port, status, detail, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, 'preparing', null, ?, ?)`,
          )
          .run(p.laneId, p.projectId, p.title, p.branch, p.baseSha, p.root, p.port, e.at, e.at);
        break;
      }
      case "lane.status": {
        const p = e.payload as { laneId: string; status: string; detail?: string };
        this.db
          .query("update lanes set status = ?, detail = ?, updated_at = ? where id = ?")
          .run(p.status, p.detail ?? null, e.at, p.laneId);
        break;
      }
      case "lane.archived": {
        const p = e.payload as { laneId: string };
        this.db
          .query("update lanes set status = 'archived', updated_at = ? where id = ?")
          .run(e.at, p.laneId);
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
      // Every projection table, or a rebuild silently keeps stale rows and
      // the "projections are disposable" property stops being true.
      this.db.exec(
        "delete from turn_diffs; delete from messages; delete from lanes; delete from threads; delete from projects;",
      );
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
        "select id, name, root_path, created_at from projects where deleted_at is null order by created_at",
      )
      .all()
      .map((r) => ({ id: r.id, name: r.name, rootPath: r.root_path, createdAt: r.created_at }));
  }

  listThreads(): ThreadView[] {
    return this.db
      .query<
        {
          id: string;
          project_id: string;
          title: string;
          provider: string;
          status: string;
          permission_mode: string;
          lane_id: string | null;
          model: string | null;
          vendor_session_id: string | null;
          updated_at: string;
        },
        []
      >(
        "select id, project_id, title, provider, status, permission_mode, lane_id, model, vendor_session_id, updated_at from threads where deleted_at is null order by updated_at desc",
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
        laneId: r.lane_id,
        permissionMode: toPermissionMode(r.permission_mode),
        model: r.model ?? null,
        vendorSessionId: r.vendor_session_id ?? null,
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

  /** Every recorded diff for a thread, used to build the handoff file list. */
  listTurnDiffs(threadId: string): Array<{ turnId: string; files: Array<{ path: string; status: string }> }> {
    return this.db
      .query<{ turn_id: string; files_json: string }, [string]>(
        "select turn_id, files_json from turn_diffs where thread_id = ?",
      )
      .all(threadId)
      .map((r) => ({
        turnId: r.turn_id,
        files: JSON.parse(r.files_json) as Array<{ path: string; status: string }>,
      }));
  }

  listLanes(projectId?: string): LaneView[] {
    // Hide lanes whose project was removed from Divisio (folder still on disk).
    const sql = projectId
      ? `select l.* from lanes l
         inner join projects p on p.id = l.project_id
         where l.project_id = ? and p.deleted_at is null
         order by l.created_at desc`
      : `select l.* from lanes l
         inner join projects p on p.id = l.project_id
         where p.deleted_at is null
         order by l.created_at desc`;
    const rows = projectId
      ? this.db.query<LaneRow, [string]>(sql).all(projectId)
      : this.db.query<LaneRow, []>(sql).all();
    return rows.map(toLaneView);
  }

  getLane(laneId: string): LaneView | null {
    const row = this.db.query<LaneRow, [string]>("select * from lanes where id = ?").get(laneId);
    return row ? toLaneView(row) : null;
  }

  /** Ports held by lanes that are not archived, so allocation never collides. */
  activeLanePorts(): Set<number> {
    return new Set(
      this.db
        .query<{ port: number }, []>(
          `select l.port from lanes l
           inner join projects p on p.id = l.project_id
           where l.status != 'archived' and p.deleted_at is null`,
        )
        .all()
        .map((r) => r.port),
    );
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

  /**
   * Local coding activity for Profile: turns, messages, streaks, provider mix.
   * Dates are machine-local calendar days.
   */
  activityStats(): ActivityStats {
    const turnRows = this.db
      .query<{ at: string; payload: string }, []>(
        "select at, payload from events where type = 'turn.started'",
      )
      .all();

    const messageRows = this.db
      .query<{ at: string }, []>("select at from messages where role = 'user'")
      .all();

    const turnByDay = new Map<string, number>();
    const providerTurns = new Map<string, number>();
    for (const row of turnRows) {
      const key = localDateKey(row.at);
      turnByDay.set(key, (turnByDay.get(key) ?? 0) + 1);
      let provider = "unknown";
      try {
        const payload = JSON.parse(row.payload) as { provider?: string };
        if (payload.provider) provider = payload.provider;
      } catch {
        /* keep unknown */
      }
      providerTurns.set(provider, (providerTurns.get(provider) ?? 0) + 1);
    }

    const messageByDay = new Map<string, number>();
    for (const row of messageRows) {
      const key = localDateKey(row.at);
      messageByDay.set(key, (messageByDay.get(key) ?? 0) + 1);
    }

    const filesTouched = this.db
      .query<{ n: number }, []>(
        `select coalesce(sum(json_array_length(files_json)), 0) as n from turn_diffs`,
      )
      .get()?.n ?? 0;

    const projects = this.db.query<{ n: number }, []>("select count(*) as n from projects").get()?.n ?? 0;
    const threads = this.db.query<{ n: number }, []>("select count(*) as n from threads").get()?.n ?? 0;

    return assembleActivityStats({
      turnDays: [...turnByDay.entries()].map(([date, turns]) => ({ date, turns })),
      messageDays: [...messageByDay.entries()].map(([date, messages]) => ({ date, messages })),
      providers: [...providerTurns.entries()].map(([kind, turns]) => ({ kind, turns })),
      threads,
      projects,
      filesTouched,
    });
  }

  close() {
    this.db.close();
  }
}
