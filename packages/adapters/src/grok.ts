/**
 * Grok Build (xAI) adapter — Stream tier.
 *
 * Drives `grok -p … --output-format streaming-json`. Current CLIs emit
 * `{type:"text",data}` token deltas; older Messages-shaped NDJSON still maps.
 * Prefer binary `grok` (not bare `agent`).
 *
 * Full-access threads pass `--always-approve`. Approvals are otherwise
 * CLI-owned (`approvals: false`).
 */

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
import { detectCli, interruptProcess, pumpClaudeLikeStream, type TurnProcess } from "./shared/streamPump.ts";
import { pushModelArg } from "./shared/modelArg.ts";
import { normalizeGrokStreamLine } from "./grok/normalize.ts";

const log = logger("adapter:grok");
const BINARY = "grok";

interface Session extends SessionHandle {
  proc: TurnProcess | null;
  cwd: string;
  permissionMode: PermissionMode;
  emit: EmitRuntimeEvent;
  nativeId: string | null;
}

const CAPABILITIES: AdapterCapabilities = {
  sessionResume: true,
  interruptTurn: true,
  modelSwitch: true,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

export class GrokAdapter implements ProviderAdapter {
  readonly kind = "grok";
  readonly label = "Grok Build";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    return detectCli(
      BINARY,
      ["version"],
      "grok not on PATH — install the xAI Grok Build CLI",
      "grok exited non-zero — try `grok` auth / login",
    );
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
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

    const args = [
      "-p",
      turn.text,
      "--output-format",
      "streaming-json",
      "--cwd",
      session.cwd,
      "--no-alt-screen",
      "--no-auto-update",
    ];
    if (session.permissionMode === "full_access") args.push("--always-approve");
    if (session.nativeId) args.push("-r", session.nativeId);
    pushModelArg(args, turn.model);

    log.info("spawning turn", { threadId: session.threadId, turnId: turn.turnId, resume: !!session.nativeId });

    const proc = Bun.spawn({
      cmd: [BINARY, ...args],
      cwd: session.cwd,
      env: { ...(process.env as Record<string, string>) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }) satisfies TurnProcess;
    session.proc = proc;
    session.emit({ type: "status", status: "running" });
    void pumpClaudeLikeStream({
      proc,
      turnId: turn.turnId,
      emit: session.emit,
      getNativeId: () => session.nativeId,
      setNativeId: (id) => {
        session.nativeId = id;
      },
      isCurrent: () => session.proc === proc,
      clearProc: () => {
        session.proc = null;
      },
      failLabel: "grok",
      normalize: normalizeGrokStreamLine,
    });
  }

  async interruptTurn(handle: SessionHandle, turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    const proc = session?.proc;
    if (!session || !proc) return;
    session.proc = null;
    await interruptProcess(proc, session.emit, turnId);
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
