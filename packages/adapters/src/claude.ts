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
import { spawnWithEnv, terminateSubprocess } from "@divisio/shared/spawn";
import { normalizeClaudeStreamLine, type ClaudeNormalizeState } from "./claude/normalize.ts";

const log = logger("adapter:claude");

/** Tools that still prompt under default/acceptEdits and get auto-denied in `--print`. */
const PRINT_ALLOWED_TOOLS = "WebSearch,WebFetch";

/** How long to wait for the CLI to acknowledge a control request. */
const CONTROL_TIMEOUT_MS = 5_000;

/** How long to wait for a `result` line after an interrupt before settling locally. */
const INTERRUPT_SETTLE_MS = 3_000;

/** Maps Divisio's two modes onto the CLI's permission vocabulary. */
function cliPermissionMode(mode: PermissionMode): string {
  return mode === "full_access" ? "acceptEdits" : "manual";
}

/**
 * Spawn argv for one long-lived session.
 *
 * `--input-format stream-json` is what makes the process reusable: user turns
 * are written as JSON lines on stdin instead of being baked into argv, so the
 * CLI's ~2s cold boot is paid once per session rather than once per turn.
 *
 * Network tools are allowlisted because there is no TTY for Claude's prompt.
 * `--allowedTools` is a Commander `<tools...>` option, so the `=` form is used
 * to keep the list attached to the flag.
 */
export function claudeSessionArgs(input: {
  nativeId: string | null;
  permissionMode: PermissionMode;
  model?: string | undefined;
}): string[] {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  args.push("--permission-mode", cliPermissionMode(input.permissionMode));
  args.push(`--allowedTools=${PRINT_ALLOWED_TOOLS}`);
  if (input.nativeId) args.push("--resume", input.nativeId);
  if (input.model) args.push("--model", input.model);
  return args;
}

/**
 * Claude Code adapter — Stream tier, warm session.
 *
 * Drives one long-lived `claude` process per thread over stream-json stdin.
 * Turns after the first skip the CLI's cold boot entirely (measured ~5.9s to
 * first token cold vs ~1.4s warm on the same prompt).
 *
 * Model and permission-mode changes ride control requests on the live process
 * rather than forcing a respawn — a respawn would mean `--resume`, which
 * replays the whole conversation as uncached input tokens.
 *
 * Stream-json parsing lives in `claude/normalize.ts` so golden fixtures can
 * replay vendor output without spawning a process.
 *
 * `approvals` stays false: `--print` runs the CLI's own permission engine and
 * hands us no decision point. The control channel can carry a `can_use_tool`
 * request, but this CLI does not raise one in print mode — verified, not
 * assumed. Declaring otherwise would put an approve/deny dialog in the UI that
 * controls nothing. WebSearch/WebFetch are allowlisted on spawn so `--print`
 * does not auto-deny them; that is not the same as `bypassPermissions`.
 */

type SessionProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface Session extends SessionHandle {
  proc: SessionProcess | null;
  cwd: string;
  /** Divisio's mode for this thread, mapped onto the CLI's own permission flag. */
  permissionMode: PermissionMode;
  /** Mode the live process was last told about. Null when no process. */
  appliedMode: PermissionMode | null;
  /** Model the live process was last told about. */
  appliedModel: string | undefined;
  emit: EmitRuntimeEvent;
  /** Vendor session id, captured from the init line, for --resume. */
  nativeId: string | null;
  activeTurnId: string | null;
  assistantText: string;
  norm: ClaudeNormalizeState;
  controlSeq: number;
  pending: Map<string, { resolve(value: unknown): void; reject(err: Error): void }>;
  /** Settle timer armed by interrupt, cleared when the CLI's `result` lands. */
  interruptTimer: ReturnType<typeof setTimeout> | null;
}

const CAPABILITIES: AdapterCapabilities = {
  sessionResume: true,
  interruptTurn: true,
  modelSwitch: true,
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
    const session: Session = {
      threadId: input.threadId,
      nativeId: input.resumeId ?? null,
      proc: null,
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "supervised",
      appliedMode: null,
      appliedModel: undefined,
      emit,
      activeTurnId: null,
      assistantText: "",
      norm: { nativeId: input.resumeId ?? null },
      controlSeq: 0,
      pending: new Map(),
      interruptTimer: null,
      close: async () => {
        await this.stopSession(session);
      },
    };
    this.sessions.set(input.threadId, session);
    // Boot the CLI now rather than on the first turn. Starting a session is the
    // signal that a turn is coming, and the cold boot is the single largest
    // component of first-token latency — paying it here spends time the user is
    // still typing in. A session that is never used is reclaimed by the idle
    // sweep, so an eager spawn cannot accumulate.
    try {
      this.ensureProcess(session);
    } catch (err) {
      // A failed spawn must surface at send time as a turn error, not here.
      log.warn("eager spawn failed; will retry on first turn", {
        threadId: input.threadId,
        detail: String(err),
      });
    }
    emit({ type: "status", status: "ready" });
    return session;
  }

  /**
   * Divisio's permission mode changed for this thread.
   *
   * Applied to the live process on the next turn via a control request, so the
   * toggle takes effect without tearing the session down.
   */
  setPermissionMode(handle: SessionHandle, mode: PermissionMode): void {
    const session = this.sessions.get(handle.threadId);
    if (session) session.permissionMode = mode;
  }

  private isAlive(session: Session): boolean {
    return session.proc !== null && session.proc.exitCode === null && session.proc.signalCode === null;
  }

  /** Spawn the long-lived process if it is not already running. */
  private ensureProcess(session: Session): SessionProcess {
    if (session.proc && this.isAlive(session)) return session.proc;

    const args = claudeSessionArgs({
      nativeId: session.nativeId,
      permissionMode: session.permissionMode,
      model: session.appliedModel,
    });

    log.info("spawning session", {
      threadId: session.threadId,
      resume: !!session.nativeId,
    });

    const proc = Bun.spawn({
      cmd: ["claude", ...args],
      cwd: session.cwd,
      // Explicit env so the daemon's repaired PATH applies; without it Bun
      // resolves the binary against the environment the process started with.
      env: { ...(process.env as Record<string, string>) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) satisfies SessionProcess;

    session.proc = proc;
    session.appliedMode = session.permissionMode;
    void this.pump(session, proc);
    void this.watchExit(session, proc);
    return proc;
  }

  private write(session: Session, payload: unknown): void {
    const proc = session.proc;
    if (!proc) return;
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    proc.stdin.flush();
  }

  /**
   * Send a control request and await the CLI's acknowledgement.
   *
   * Resolves to false rather than throwing when the CLI does not answer: a
   * missing ack must not fail the user's turn.
   */
  private async control(
    session: Session,
    subtype: string,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!session.proc || !this.isAlive(session)) return false;
    const requestId = `div-${++session.controlSeq}`;
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        log.warn("control request timed out", { threadId: session.threadId, subtype });
        resolve(false);
      }, CONTROL_TIMEOUT_MS);
      session.pending.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(false);
        },
      });
    });
    this.write(session, { type: "control_request", request_id: requestId, request: { subtype, ...extra } });
    return await answered;
  }

  async sendTurn(handle: SessionHandle, turn: SendTurnInput): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) throw new Error(`no session for thread ${handle.threadId}`);
    if (session.activeTurnId) throw new Error("turn already running");

    const wasAlive = this.isAlive(session);
    this.ensureProcess(session);

    // Reconfigure the live process instead of respawning. A respawn would mean
    // `--resume`, replaying the whole conversation as uncached input tokens.
    if (wasAlive) {
      if (session.appliedMode !== session.permissionMode) {
        const mode = cliPermissionMode(session.permissionMode);
        if (await this.control(session, "set_permission_mode", { mode })) {
          session.appliedMode = session.permissionMode;
        }
      }
      if (turn.model && turn.model !== session.appliedModel) {
        if (await this.control(session, "set_model", { model: turn.model })) {
          session.appliedModel = turn.model;
        }
      }
    } else if (turn.model) {
      // Fresh process — the model went in on argv.
      session.appliedModel = turn.model;
    }

    session.activeTurnId = turn.turnId;
    session.assistantText = "";
    session.emit({ type: "status", status: "running" });

    this.write(session, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: turn.text }] },
    });
  }

  /** Emit turn-end events exactly once for `turnId`. */
  private settleTurn(session: Session, turnId: string): void {
    if (session.activeTurnId !== turnId) return;
    if (session.interruptTimer) {
      clearTimeout(session.interruptTimer);
      session.interruptTimer = null;
    }
    const text = session.assistantText;
    session.activeTurnId = null;
    session.assistantText = "";
    if (text.length > 0) {
      session.emit({ type: "assistant.message", turnId, text });
    }
    session.emit({ type: "turn.completed", turnId });
    session.emit({ type: "status", status: "ready" });
  }

  private async pump(session: Session, proc: SessionProcess) {
    let buffer = "";
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
          this.handleLine(session, proc, msg);
        }
      }
    } catch (err) {
      // Gated: a process replaced by a respawn must not report against the
      // session that has already moved on.
      if (session.proc === proc) {
        session.emit({ type: "error", code: "stream_failed", message: String(err) });
      }
    }
  }

  private handleLine(session: Session, proc: SessionProcess, msg: Record<string, unknown>): void {
    if (session.proc !== proc) return;

    if (msg["type"] === "control_response") {
      const response = msg["response"] as Record<string, unknown> | undefined;
      const id = response?.["request_id"];
      if (typeof id === "string") {
        const waiter = session.pending.get(id);
        session.pending.delete(id);
        if (response?.["subtype"] === "error") {
          waiter?.reject(new Error(String(response["error"] ?? "control error")));
        } else {
          waiter?.resolve(response);
        }
      }
      return;
    }

    if (msg["type"] === "control_request") {
      // Nothing is claimed on the control channel, so anything the CLI asks
      // must be answered rather than left to block the turn.
      const id = msg["request_id"];
      const request = msg["request"] as { subtype?: unknown } | undefined;
      log.warn("unhandled control request", { subtype: String(request?.subtype) });
      this.write(session, {
        type: "control_response",
        response: { subtype: "error", request_id: id, error: "unsupported by Divisio" },
      });
      return;
    }

    const turnId = session.activeTurnId;
    if (!turnId) return;

    const result = normalizeClaudeStreamLine(msg, turnId, session.norm);
    session.norm = result.state;
    if (result.state.nativeId) session.nativeId = result.state.nativeId;
    for (const event of result.events) session.emit(event);
    session.assistantText += result.text;

    // `result` is the turn boundary in stream-json mode; the process stays up.
    if (msg["type"] === "result") this.settleTurn(session, turnId);
  }

  /** Report a process that died outside our control, and let the next turn respawn. */
  private async watchExit(session: Session, proc: SessionProcess) {
    const code = await proc.exited;
    if (session.proc !== proc) return;

    const stderr = await new Response(proc.stderr).text().catch(() => "");
    session.proc = null;
    session.appliedMode = null;
    for (const waiter of session.pending.values()) waiter.reject(new Error("session exited"));
    session.pending.clear();

    const turnId = session.activeTurnId;
    if (turnId) {
      if (code !== 0 && code !== null) {
        session.emit({
          type: "error",
          code: "provider_failed",
          message: stderr.trim().split("\n").slice(-3).join(" ") || `claude exited ${code}`,
        });
      }
      this.settleTurn(session, turnId);
    }
  }

  async interruptTurn(handle: SessionHandle, turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session || session.activeTurnId !== turnId) return;

    // Report `stopping`, not `ready`. The process may still be writing files;
    // claiming ready here would be a lie the UI acts on.
    session.emit({ type: "status", status: "stopping" });

    // Interrupt over the control channel keeps the session warm, so the next
    // turn does not pay a cold boot just because the user pressed Stop.
    const acked = await this.control(session, "interrupt");

    if (acked) {
      // The CLI answers an interrupt with a `result` line; settle on that so
      // usage counters from the partial turn are not dropped. Fall back to a
      // local settle if it never arrives.
      if (session.activeTurnId === turnId && !session.interruptTimer) {
        session.interruptTimer = setTimeout(() => {
          session.interruptTimer = null;
          this.settleTurn(session, turnId);
        }, INTERRUPT_SETTLE_MS);
      }
      return;
    }

    // Control channel is not answering — fall back to killing the process.
    const proc = session.proc;
    session.proc = null;
    session.appliedMode = null;
    if (proc) await terminateSubprocess(proc);
    this.settleTurn(session, turnId);
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    const proc = session.proc;
    session.proc = null;
    if (proc) await terminateSubprocess(proc, 500);
    this.sessions.delete(handle.threadId);
    session.emit({ type: "session.exited", code: null, signal: null });
  }
}
