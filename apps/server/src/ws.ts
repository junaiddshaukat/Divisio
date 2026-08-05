import type { ServerWebSocket } from "bun";
import {
  CommandError,
  type ClientFrame,
  type DomainEvent,
  type ServerFrame,
} from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import type { Orchestrator } from "./orchestrator.ts";
import type { EventStore } from "./store/log.ts";

const log = logger("ws");

/** How many recent events stay available for gap replay before a snapshot is required. */
export const DEFAULT_REPLAY_WINDOW = 5_000;
/** Delta flush cadence — one frame per render frame, not one per token. */
const FLUSH_MS = 16;
/** Above this many bytes queued, the client is too slow and deltas collapse. */
const BACKPRESSURE_BYTES = 1_000_000;

export interface SocketData {
  clientId: string;
  threads: Set<string>;
  /** Pending deltas per turn, flushed on a tick. */
  pending: Map<string, { threadId: string; text: string }>;
  timer: ReturnType<typeof setTimeout> | null;
  catchUp: boolean;
}

export interface WsHubOptions {
  /** Override the replay retention window (tests use a small value). */
  replayWindow?: number;
}

export class WsHub {
  private readonly clients = new Set<ServerWebSocket<SocketData>>();
  private readonly replayWindow: number;

  constructor(
    private readonly store: EventStore,
    private readonly environmentId: string,
    options: WsHubOptions = {},
  ) {
    this.replayWindow = options.replayWindow ?? DEFAULT_REPLAY_WINDOW;
  }

  private orchestrator!: Orchestrator;
  attach(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  open(ws: ServerWebSocket<SocketData>, protocol: string) {
    this.clients.add(ws);
    this.send(ws, {
      t: "ready",
      protocol,
      environmentId: this.environmentId,
      seq: this.store.head(),
    });
  }

  close(ws: ServerWebSocket<SocketData>) {
    if (ws.data.timer) clearTimeout(ws.data.timer);
    this.clients.delete(ws);
  }

  /* ------------------------------ broadcasting ----------------------------- */

  /**
   * Domain events are never dropped or collapsed — only deltas are.
   * Pending deltas flush first so a client cannot see `turn.completed`
   * before the text it completes.
   */
  events(events: DomainEvent[]) {
    for (const ws of this.clients) {
      const relevant = events.filter((e) => e.threadId === null || ws.data.threads.has(e.threadId));
      if (relevant.length === 0) continue;
      this.flush(ws);
      for (const event of relevant) this.send(ws, { t: "evt", event });
    }
  }

  delta(threadId: string, turnId: string, text: string) {
    for (const ws of this.clients) {
      if (!ws.data.threads.has(threadId)) continue;
      const existing = ws.data.pending.get(turnId);
      if (existing) existing.text += text;
      else ws.data.pending.set(turnId, { threadId, text });

      // Catch-up mode: keep accumulating, stop scheduling. The user sees text
      // jump forward rather than stream — correct, just less pretty.
      if (ws.getBufferedAmount() > BACKPRESSURE_BYTES) {
        ws.data.catchUp = true;
        continue;
      }
      ws.data.catchUp = false;
      if (!ws.data.timer) {
        ws.data.timer = setTimeout(() => {
          ws.data.timer = null;
          this.flush(ws);
        }, FLUSH_MS);
      }
    }
  }

  private flush(ws: ServerWebSocket<SocketData>) {
    if (ws.data.pending.size === 0) return;
    for (const [turnId, entry] of ws.data.pending) {
      this.send(ws, { t: "delta", threadId: entry.threadId, turnId, text: entry.text });
    }
    ws.data.pending.clear();
  }

  private send(ws: ServerWebSocket<SocketData>, frame: ServerFrame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log.warn("send failed", { clientId: ws.data.clientId, err: String(err) });
    }
  }

  /* ------------------------------- messages -------------------------------- */

  async message(ws: ServerWebSocket<SocketData>, raw: string) {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.send(ws, { t: "err", id: "", code: "bad_frame", message: "invalid JSON", retryable: false });
      return;
    }

    if (frame.t === "sub") {
      // Replaces the set outright; it is not additive.
      ws.data.threads = new Set(frame.threads);
      return;
    }

    if (frame.t !== "req") {
      this.send(ws, { t: "err", id: "", code: "bad_frame", message: "unknown frame type", retryable: false });
      return;
    }

    // Resume is handled here, not in the orchestrator: it is a transport concern.
    if (frame.cmd === "session.resume") {
      this.resume(ws, frame.id, frame.payload as { since: number; threads: string[] });
      return;
    }

    try {
      const payload = await this.orchestrator.dispatch(frame.cmd, frame.payload as never);
      this.send(ws, { t: "res", id: frame.id, payload: payload as never });
    } catch (err) {
      if (err instanceof CommandError) {
        this.send(ws, { t: "err", id: frame.id, code: err.code, message: err.message, retryable: err.retryable });
      } else {
        log.error("command failed", { cmd: frame.cmd, err: String(err) });
        this.send(ws, { t: "err", id: frame.id, code: "internal", message: String(err), retryable: false });
      }
    }
  }

  /**
   * Replays the gap, or tells the client to take a snapshot.
   * `snapshot_required` is a routine response, not an error.
   */
  private resume(ws: ServerWebSocket<SocketData>, id: string, payload: { since: number; threads: string[] }) {
    ws.data.threads = new Set(payload.threads);
    const head = this.store.head();

    if (payload.since > head || head - payload.since > this.replayWindow) {
      this.send(ws, { t: "res", id, payload: { mode: "snapshot_required" } as never });
      return;
    }

    const events = this.store.readSince(payload.since, this.replayWindow);
    this.send(ws, { t: "res", id, payload: { mode: "replay", through: head } as never });
    for (const event of events) {
      if (event.threadId === null || ws.data.threads.has(event.threadId)) {
        this.send(ws, { t: "evt", event });
      }
    }
  }
}
