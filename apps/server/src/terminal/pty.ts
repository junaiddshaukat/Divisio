import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { logger } from "@divisio/shared/log";

const log = logger("terminal");

/**
 * Terminal sessions backed by a real PTY.
 *
 * A pipe is not a substitute: without a pty, programs disable colour, refuse to
 * prompt, and buffer their output, so anything interactive appears to hang.
 */

export interface PtySession {
  id: string;
  threadId: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): {
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
};

/**
 * node-pty ships `spawn-helper` without the executable bit under some package
 * managers, and node-pty exec's it to allocate the pty. The failure surfaces as
 * a bare "posix_spawnp failed", which says nothing about the cause — so repair
 * it at startup rather than leaving users to decode that.
 */
export function ensureSpawnHelperExecutable(moduleDir: string): void {
  const platform = `${process.platform}-${process.arch}`;
  const helper = join(moduleDir, "prebuilds", platform, "spawn-helper");
  if (!existsSync(helper)) return;
  try {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      log.info("made node-pty spawn-helper executable", { helper });
    }
  } catch (err) {
    log.warn("could not adjust spawn-helper permissions", { detail: String(err) });
  }
}

let ptyModule: PtyModule | null = null;
let ptyError: string | null = null;

function loadPty(): PtyModule | null {
  if (ptyModule || ptyError) return ptyModule;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("node-pty");
    ensureSpawnHelperExecutable(join(resolved, "..", ".."));
    ptyModule = require("node-pty") as PtyModule;
    return ptyModule;
  } catch (err) {
    // A terminal is a feature, not a dependency of the daemon. Failing to load
    // it must not take the rest of the app down.
    ptyError = String(err);
    log.warn("node-pty unavailable; terminals are disabled", { detail: ptyError });
    return null;
  }
}

export function terminalsAvailable(): boolean {
  return loadPty() !== null;
}

export interface PtyCallbacks {
  onData(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number): void;
}

export class TerminalManager {
  private readonly sessions = new Map<string, PtySession>();

  constructor(private readonly callbacks: PtyCallbacks) {}

  open(id: string, threadId: string, cwd: string, cols: number, rows: number): PtySession {
    const pty = loadPty();
    if (!pty) throw new Error("terminals are unavailable: node-pty could not be loaded");

    const shell = process.env["SHELL"] || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        // Tells programs a capable terminal is present, so they emit colour.
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    proc.onData((data) => this.callbacks.onData(id, data));
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.callbacks.onExit(id, exitCode);
    });

    const session: PtySession = {
      id,
      threadId,
      write: (data) => proc.write(data),
      resize: (c, r) => proc.resize(Math.max(1, c), Math.max(1, r)),
      kill: () => {
        try {
          proc.kill();
        } catch {
          // Already gone; onExit has run or will.
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
