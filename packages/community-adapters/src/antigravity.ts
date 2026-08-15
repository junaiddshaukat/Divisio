/**
 * Antigravity CLI community adapter — Stream tier.
 * `agy -p … --output-format stream-json`
 * Install: https://antigravity.google/cli/install.sh
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
import { detectCli, interruptProcess, pushModelArg, type TurnProcess } from "@divisio/adapters";
import { logger } from "@divisio/shared/log";
import {
  normalizeAntigravityStreamLine,
  type AntigravityNormalizeState,
} from "./antigravity/normalize.ts";
import { pumpCommunityNdjson } from "./shared/pump.ts";

const log = logger("community:antigravity");
const BINARY = "agy";

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

export class AntigravityAdapter implements ProviderAdapter {
  readonly kind = "antigravity";
  readonly label = "Antigravity";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    return detectCli(
      BINARY,
      ["--version"],
      "agy not on PATH — install from https://antigravity.google/cli/install.sh",
      "agy exited non-zero — run interactive `agy` once to authenticate",
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

    const args = ["-p", turn.text, "--output-format", "stream-json"];
    if (session.nativeId) args.push("--conversation", session.nativeId);
    if (session.permissionMode === "full_access") {
      args.push("--dangerously-skip-permissions");
    }
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

    const initial: AntigravityNormalizeState = {
      nativeId: session.nativeId,
      activeTools: new Map(),
      toolSeq: 0,
      hadAssistantText: false,
    };
    void pumpCommunityNdjson({
      proc,
      turnId: turn.turnId,
      emit: session.emit,
      failLabel: "agy",
      initialState: initial,
      normalize: normalizeAntigravityStreamLine,
      onNativeId: (id) => {
        session.nativeId = id;
      },
      isCurrent: () => session.proc === proc,
      clearProc: () => {
        session.proc = null;
      },
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
