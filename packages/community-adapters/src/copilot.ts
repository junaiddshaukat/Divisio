/**
 * GitHub Copilot CLI community adapter — Stream tier.
 * `copilot -p … --output-format json -s` (+ `--allow-all` in full-access)
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
import { detectCli, interruptProcess, type TurnProcess } from "@divisio/adapters";
import { logger } from "@divisio/shared/log";
import { normalizeCopilotStreamLine, type CopilotNormalizeState } from "./copilot/normalize.ts";
import { pumpCommunityNdjson } from "./shared/pump.ts";

const log = logger("community:copilot");
const BINARY = "copilot";

interface Session extends SessionHandle {
  proc: TurnProcess | null;
  cwd: string;
  permissionMode: PermissionMode;
  emit: EmitRuntimeEvent;
  nativeId: string | null;
}

const CAPABILITIES: AdapterCapabilities = {
  sessionResume: false,
  interruptTurn: true,
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

export class CopilotAdapter implements ProviderAdapter {
  readonly kind = "copilot";
  readonly label = "GitHub Copilot";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    return detectCli(
      BINARY,
      ["--version"],
      "copilot not on PATH — npm i -g @github/copilot",
      "copilot exited non-zero — try `copilot` login / gh auth",
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

    const args = ["-p", turn.text, "--output-format", "json", "-s", "--no-ask-user"];
    if (session.permissionMode === "full_access") {
      args.push("--allow-all");
    }

    log.info("spawning turn", { threadId: session.threadId, turnId: turn.turnId });

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

    const initial: CopilotNormalizeState = {
      nativeId: session.nativeId,
      seenTools: new Set(),
      hadDelta: false,
    };
    void pumpCommunityNdjson({
      proc,
      turnId: turn.turnId,
      emit: session.emit,
      failLabel: "copilot",
      initialState: initial,
      normalize: normalizeCopilotStreamLine,
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
