import { REQUIRED_COMMANDS } from "@divisio/contracts";
import type {
  CommandName,
  CommandPayloads,
  CommandResults,
  DomainEvent,
  ServerFrame,
} from "@divisio/contracts";

/**
 * Daemon connection: request correlation, reconnect with a cursor, and the
 * snapshot fallback.
 *
 * `snapshot_required` is a routine response, not an error — the client never
 * assumes it can resume, because assuming that is how history silently
 * diverges after a long disconnect.
 */

export type ConnectionState = "connecting" | "open" | "closed";

type TerminalSink = { data(chunk: string): void; exit(code: number): void };

interface Handlers {
  /** Commands the UI needs that this daemon does not route. */
  onIncompatible(missing: string[]): void;
  onEvent(event: DomainEvent): void;
  onDelta(threadId: string, turnId: string, text: string): void;
  onState(state: ConnectionState): void;
  /** Cursor was too old to replay; caller must refetch from scratch. */
  onResync(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class Client {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private seq = 0;
  private threads: string[] = [];
  private retry = 0;
  /** Terminal output is routed per session rather than broadcast. */
  private readonly terminalSinks = new Map<string, TerminalSink>();
  private closedByUser = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: Handlers,
  ) {}

  connect() {
    this.closedByUser = false;
    this.handlers.onState("connecting");

    // Browsers cannot set headers on a WebSocket handshake, so the token rides
    // in the subprotocol list rather than the query string. Query strings leak
    // into logs, history, and Referer headers.
    const ws = new WebSocket(this.url, ["divisio.v1", `bearer.${this.token}`]);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onState("open");
    };

    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handleFrame(frame);
    };

    ws.onclose = () => {
      this.ws = null;
      this.handlers.onState("closed");
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    const delay = Math.min(500 * 2 ** this.retry++, 8000);
    setTimeout(() => this.connect(), delay);
  }

  private handleFrame(frame: ServerFrame) {
    switch (frame.t) {
      case "ready": {
        // A daemon can be older than the UI — a stale dev process holding the
        // port, or a desktop shell that adopted one. Report that once, by name,
        // instead of letting every feature fail separately with
        // "unknown command" wherever the user happens to click.
        // Only usable when the daemon is new enough to advertise. An older one
        // sends nothing here, which is precisely the case that needs catching —
        // so the authoritative check is the `unknown_command` reply below.
        if (frame.commands) {
          const advertised = new Set(frame.commands);
          const missing = REQUIRED_COMMANDS.filter((c) => !advertised.has(c));
          if (missing.length > 0) this.handlers.onIncompatible(missing);
        }
        // First connection starts at head; a reconnect asks for its gap.
        if (this.seq === 0) this.seq = frame.seq;
        else void this.resume();
        this.subscribe(this.threads);
        return;
      }

      case "evt":
        this.seq = Math.max(this.seq, frame.event.seq);
        this.handlers.onEvent(frame.event);
        return;

      case "delta":
        this.handlers.onDelta(frame.threadId, frame.turnId, frame.text);
        return;

      case "term":
        this.terminalSinks.get(frame.sessionId)?.data(frame.data);
        return;

      case "term.exit":
        this.terminalSinks.get(frame.sessionId)?.exit(frame.exitCode);
        return;

      case "res": {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          p.resolve(frame.payload);
        }
        return;
      }

      case "err": {
        // A daemon that does not know a command we require is an older build,
        // whatever it claims at connect. This catches the stale-daemon case
        // that cannot advertise its commands at all.
        if (frame.code === "unknown_command") {
          const name = frame.message.replace(/^unknown command:\s*/, "").trim();
          if ((REQUIRED_COMMANDS as readonly string[]).includes(name)) {
            this.handlers.onIncompatible([name]);
          }
        }
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          p.reject(new Error(frame.message));
        }
        return;
      }
    }
  }

  private async resume() {
    try {
      const res = (await this.send("session.resume", {
        since: this.seq,
        threads: this.threads,
      })) as CommandResults["session.resume"];
      if (res.mode === "snapshot_required") {
        this.seq = 0;
        this.handlers.onResync();
      }
    } catch {
      this.handlers.onResync();
    }
  }

  subscribe(threads: string[]) {
    this.threads = threads;
    this.ws?.send(JSON.stringify({ t: "sub", threads }));
  }

  send<C extends CommandName>(
    cmd: C,
    payload: CommandPayloads[C],
    opts?: { timeoutMs?: number },
  ): Promise<CommandResults[C]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = `c${++this.nextId}`;
    // Handoff waits on a full source-agent turn (up to ~3 min server-side).
    const timeoutMs =
      opts?.timeoutMs ??
      (cmd === "thread.handoff" ? 210_000 : cmd === "project.clone" ? 120_000 : 30_000);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ t: "req", id, cmd, payload }));
      // A timed-out request is NOT implicitly cancelled — the command may have
      // committed events. Stopping work needs turn.interrupt.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${cmd} timed out`));
      }, timeoutMs);
    });
  }

  onTerminal(sessionId: string, sink: TerminalSink): () => void {
    this.terminalSinks.set(sessionId, sink);
    return () => this.terminalSinks.delete(sessionId);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}
