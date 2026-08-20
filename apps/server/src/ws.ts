import type { ServerWebSocket } from "bun";
import {
  CommandError,
  DAEMON_GENERATION,
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
/** When the socket is behind, still flush — just slower, coalesced. */
const CATCH_UP_FLUSH_MS = 50;
/** Above this many bytes queued, the client is too slow and deltas collapse. */
const BACKPRESSURE_BYTES = 1_000_000;

export interface SocketData {
  clientId: string;
  /** Paired-client id when the connection authenticated with a session token. */
  pairedClientId: string | null;
  threads: Set<string>;
  /** Pending deltas per turn, flushed on a tick. */
  pending: Map<string, { threadId: string; text: string }>;
  timer: ReturnType<typeof setTimeout> | null;
  catchUp: boolean;
  /** Terminals opened by this socket, closed when it goes away. */
  terminals: Set<string>;
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
  /** Installed by the daemon; handles terminal.* with the owning socket. */
  terminals:
    | ((ws: ServerWebSocket<SocketData>, cmd: string, payload: unknown) => Promise<unknown>)
    | null = null;
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
      generation: DAEMON_GENERATION,
      commands: this.supportedCommands,
    });
  }

  /** Set by the daemon from the commands it actually routes. */
  supportedCommands: string[] = [];

  /**
   * Drops every socket belonging to a revoked client.
   * Revocation that only refuses the next connection leaves an attacker
   * connected for as long as they keep the socket open.
   */
  disconnectClient(pairedClientId: string) {
    for (const ws of this.clients) {
      if (ws.data.pairedClientId !== pairedClientId) continue;
      log.info("closing socket for revoked client", { pairedClientId });
      ws.close(4003, "revoked");
    }
  }

  close(ws: ServerWebSocket<SocketData>) {
    if (ws.data.timer) clearTimeout(ws.data.timer);
    // A shell outlives its socket otherwise, holding a process per refresh.
    for (const sessionId of ws.data.terminals) this.onSocketGone?.(sessionId);
    this.clients.delete(ws);
  }

  /** Set by the daemon so a closed socket takes its terminals with it. */
  onSocketGone: ((sessionId: string) => void) | null = null;

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

      // Catch-up only slows the tick and coalesces. Never skip the timer —
      // otherwise text sits until the next domain event (usually turn.completed).
      const catchUp = ws.getBufferedAmount() > BACKPRESSURE_BYTES;
      ws.data.catchUp = catchUp;
      if (!ws.data.timer) {
        ws.data.timer = setTimeout(() => {
          ws.data.timer = null;
          this.flush(ws);
        }, catchUp ? CATCH_UP_FLUSH_MS : FLUSH_MS);
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

  /**
   * Terminal output goes only to the socket that owns the session. Unlike
   * domain events, a shell is not shared state — another client watching a
   * thread has no business seeing keystrokes typed into it.
   */
  terminalData(sessionId: string, data: string) {
    for (const ws of this.clients) {
      if (ws.data.terminals.has(sessionId)) this.send(ws, { t: "term", sessionId, data });
    }
  }

  terminalExit(sessionId: string, exitCode: number) {
    for (const ws of this.clients) {
      if (!ws.data.terminals.has(sessionId)) continue;
      ws.data.terminals.delete(sessionId);
      this.send(ws, { t: "term.exit", sessionId, exitCode });
    }
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

    // Terminal commands need the socket, since a shell belongs to one client
    // rather than to the thread.
    if (frame.cmd.startsWith("terminal.")) {
      try {
        const payload = await this.terminals!(ws, frame.cmd, frame.payload);
        this.send(ws, { t: "res", id: frame.id, payload: payload as never });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.send(ws, { t: "err", id: frame.id, code: "internal", message, retryable: false });
      }
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
