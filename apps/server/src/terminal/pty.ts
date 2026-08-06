import { logger } from "@divisio/shared/log";

const log = logger("terminal");
const decoder = new TextDecoder();

/**
 * Terminal sessions backed by a real PTY via Bun.Terminal.
 *
 * A pipe is not a substitute: without a pty, programs disable colour, refuse to
 * prompt, and buffer their output, so anything interactive appears to hang.
 *
 * We intentionally do **not** use `node-pty`. That native addon cannot load from
 * a `bun build --compile` sidecar (`/$bunfs`), and under older Bun releases its
 * `onData` path was broken anyway. Bun ≥1.3.5 ships PTY support that works
 * inside the compiled daemon — see ADR 0008.
 */

export interface PtySession {
  id: string;
  threadId: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyCallbacks {
  onData(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number): void;
}

type BunTerminal = {
  write(data: string | Uint8Array): number | void;
  resize(cols: number, rows: number): void;
  close(): void;
};

/** True when this Bun build exposes the Terminal / spawn-PTY API. */
export function terminalsAvailable(): boolean {
  return typeof Bun !== "undefined" && typeof (Bun as { Terminal?: unknown }).Terminal === "function";
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env["COMSPEC"] || "powershell.exe";
  }
  return process.env["SHELL"] || "/bin/bash";
}

export class TerminalManager {
  private readonly sessions = new Map<string, PtySession>();

  constructor(private readonly callbacks: PtyCallbacks) {}

  open(id: string, threadId: string, cwd: string, cols: number, rows: number): PtySession {
    if (!terminalsAvailable()) {
      throw new Error("terminals are unavailable: this Bun build has no PTY support (need ≥1.3.5)");
    }

    const shell = defaultShell();
    // Login shell on POSIX so PATH / rc files match an interactive Terminal.app.
    const argv = process.platform === "win32" ? [shell] : [shell, "-l"];

    let term: BunTerminal | null = null;

    const proc = Bun.spawn(argv, {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      terminal: {
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
        name: "xterm-256color",
        data: (_t, data) => {
          this.callbacks.onData(id, decoder.decode(data));
        },
      },
    });

    term = proc.terminal as BunTerminal | null;
    if (!term) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      throw new Error("terminals are unavailable: Bun.spawn did not attach a PTY");
    }

    void proc.exited.then((code) => {
      this.sessions.delete(id);
      try {
        term?.close();
      } catch {
        /* already closed */
      }
      this.callbacks.onExit(id, code ?? 1);
    });

    const session: PtySession = {
      id,
      threadId,
      write: (data) => {
        term?.write(data);
      },
      resize: (c, r) => {
        term?.resize(Math.max(1, c), Math.max(1, r));
      },
      kill: () => {
        try {
          proc.kill();
        } catch {
          // Already gone; exited has run or will.
        }
        try {
          term?.close();
        } catch {
          /* ignore */
        }
      },
    };
    this.sessions.set(id, session);
    log.info("terminal opened", { id, threadId, shell });
    return session;
  }

  get(id: string): PtySession | null {
    return this.sessions.get(id) ?? null;
  }

  /** Closes every terminal for a thread, e.g. when its lane is archived. */
  closeForThread(threadId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.threadId === threadId) {
        session.kill();
        this.sessions.delete(session.id);
      }
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
