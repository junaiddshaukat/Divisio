import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type DetectResult,
  type EmitRuntimeEvent,
  type ProviderAdapter,
  type SendTurnInput,
  type PermissionMode,
  type SessionHandle,
  type StartSessionInput,
} from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { spawnWithEnv } from "@divisio/shared/spawn";
import { normalizeClaudeStreamLine } from "./claude/normalize.ts";

const log = logger("adapter:claude");

/**
 * Claude Code adapter — Stream tier.
 *
 * Drives the `claude` CLI in `--print --output-format stream-json` mode, one
 * process per turn. The CLI owns its own auth; we never see a key.
 *
 * Stream-json parsing lives in `claude/normalize.ts` so golden fixtures can
 * replay vendor output without spawning a process.
 *
 * Capabilities are declared from what this transport can actually do, not from
 * what the product roadmap wants. `approvals` is false: in print mode the CLI
 * runs its own permission engine and does not hand us a decision point. Claiming
 * otherwise would put an approve/deny dialog in the UI that controls nothing.
 */

/** stdin ignored, stdout+stderr piped — keeps stdout typed as a ReadableStream. */
type TurnProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface Session extends SessionHandle {
  proc: TurnProcess | null;
  cwd: string;
  /** Divisio's mode for this thread, mapped onto the CLI's own permission flag. */
  permissionMode: PermissionMode;
  emit: EmitRuntimeEvent;
  /** Vendor session id, captured from the init line, for --resume. */
  nativeId: string | null;
}

const CAPABILITIES: AdapterCapabilities = {
  sessionResume: true,
  interruptTurn: true,
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: true,
};

export class ClaudeAdapter implements ProviderAdapter {
  readonly kind = "claude";
  readonly label = "Claude Code";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    try {
      const proc = spawnWithEnv(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) {
        return { available: false, version: null, detail: "claude exited non-zero — try `claude auth login`" };
      }
      const version = out.trim().split(/\s+/)[0] ?? null;
      return { available: true, version, detail: null };
    } catch {
      return { available: false, version: null, detail: "claude not on PATH — install the Claude Code CLI" };
    }
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    // Stream tier spawns per turn, so "starting a session" is bookkeeping only.
    // The handle exists so orchestration treats every tier identically.
    const session: Session = {
      threadId: input.threadId,
      nativeId: input.resumeId ?? null,
      proc: null,
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "supervised",
      emit,
      close: async () => {
        await this.stopSession(session);
      },
    };
    this.sessions.set(input.threadId, session);
    emit({ type: "status", status: "ready" });
    return session;
  }

  async sendTurn(handle: SessionHandle, turn: SendTurnInput): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) throw new Error(`no session for thread ${handle.threadId}`);
    if (session.proc) throw new Error("turn already running");

    const args = ["--print", "--output-format", "stream-json", "--verbose"];

    // Without an explicit mode the CLI refuses every edit in print mode, so a
    // thread could talk but never change a file and full access meant nothing.
    // `acceptEdits` allows file writes while still refusing the destructive
    // classes the CLI gates separately — closer to what "full access" implies
    // here than bypassing every check.
    args.push("--permission-mode", session.permissionMode === "full_access" ? "acceptEdits" : "manual");

    if (session.nativeId) args.push("--resume", session.nativeId);
    args.push(turn.text);

    log.info("spawning turn", { threadId: session.threadId, turnId: turn.turnId, resume: !!session.nativeId });

    const proc = Bun.spawn({
      cmd: ["claude", ...args],
      cwd: session.cwd,
      // Explicit env so the daemon's repaired PATH applies; without it Bun
      // resolves the binary against the environment the process started with.
      env: { ...(process.env as Record<string, string>) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }) satisfies TurnProcess;
    session.proc = proc;
    session.emit({ type: "status", status: "running" });

    // Read stdout without blocking the caller; the daemon must stay responsive.
    void this.pump(session, proc, turn.turnId);
  }

  private async pump(session: Session, proc: TurnProcess, turnId: string) {
    let assistantText = "";
    let buffer = "";
    let normState = { nativeId: session.nativeId };

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON: a chunk boundary can split a line, so keep the remainder.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(trimmed);
          } catch {
            log.warn("unparseable stream line", { sample: trimmed.slice(0, 120) });
            continue;
          }
          const result = normalizeClaudeStreamLine(msg, turnId, normState);
          normState = result.state;
          if (normState.nativeId) session.nativeId = normState.nativeId;
          for (const event of result.events) session.emit(event);
          assistantText += result.text;
        }
      }

      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      if (code !== 0 && code !== null) {
        // Interrupt kills the process; that path reports itself and clears proc.
        if (session.proc === proc) {
          session.emit({
            type: "error",
            code: "provider_failed",
            message: stderr.trim().split("\n").slice(-3).join(" ") || `claude exited ${code}`,
          });
        }
      } else if (assistantText.length > 0) {
        session.emit({ type: "assistant.message", turnId, text: assistantText });
      }
    } catch (err) {
      session.emit({ type: "error", code: "stream_failed", message: String(err) });
    } finally {
      if (session.proc === proc) {
        session.proc = null;
        session.emit({ type: "turn.completed", turnId });
        session.emit({ type: "status", status: "ready" });
      }
    }
  }

  async interruptTurn(handle: SessionHandle, turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    const proc = session?.proc;
    if (!session || !proc) return;

    // Report `stopping`, not `ready`. The process may still be writing files;
    // claiming ready here would be a lie the UI acts on.
    session.emit({ type: "status", status: "stopping" });
    session.proc = null;

    proc.kill("SIGTERM");
    const deadline = Bun.sleep(2000).then(() => "timeout" as const);
    const exited = proc.exited.then(() => "exited" as const);
    if ((await Promise.race([exited, deadline])) === "timeout") {
      log.warn("provider ignored SIGTERM, escalating", { threadId: session.threadId });
      proc.kill("SIGKILL");
      await proc.exited;
    }

    session.emit({ type: "turn.completed", turnId });
    session.emit({ type: "status", status: "ready" });
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    if (session.proc) {
      session.proc.kill("SIGKILL");
      await session.proc.exited;
    }
    this.sessions.delete(handle.threadId);
    session.emit({ type: "session.exited", code: null, signal: null });
  }
}
