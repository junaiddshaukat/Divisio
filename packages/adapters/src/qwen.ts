/**
 * Qwen Code adapter — Stream tier.
 *
 * Drives `qwen -p … -o stream-json --include-partial-messages`.
 * Wire format matches Claude stream-json (system, stream_event, assistant,
 * result), so we reuse the Claude normalizer.
 *
 * Auth stays in the CLI; Divisio never sees a key. Approvals are CLI-owned
 * in print mode (`approvals: false`).
 */

import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type DetectResult,
  type EmitRuntimeEvent,
  type ModelCatalog,
  type ProviderAdapter,
  type SendTurnInput,
  type PermissionMode,
  type SessionHandle,
  type StartSessionInput,
} from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { detectCli, interruptProcess, pumpClaudeLikeStream, type TurnProcess } from "./shared/streamPump.ts";
import { pushModelArg } from "./shared/modelArg.ts";
import { readQwenModelCatalog } from "./qwen/settings.ts";

const log = logger("adapter:qwen");
const BINARY = "qwen";

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

export class QwenAdapter implements ProviderAdapter {
  readonly kind = "qwen";
  readonly label = "Qwen Code";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    return detectCli(
      BINARY,
      ["--version"],
      "qwen not on PATH — install Qwen Code CLI",
      "qwen exited non-zero — check auth / ModelScope token",
    );
  }

  async listModels(): Promise<ModelCatalog> {
    return readQwenModelCatalog();
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

    // Qwen Code: -p prompt, -o stream-json, token deltas, -r session id.
    // `--include-partial-messages` is a hidden yargs flag; without it the CLI
    // only emits a finished assistant snapshot after the turn.
    const args = ["-p", turn.text, "-o", "stream-json", "--include-partial-messages"];
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
      failLabel: "qwen",
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
