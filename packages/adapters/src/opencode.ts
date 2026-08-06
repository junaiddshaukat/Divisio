/**
 * OpenCode adapter — Stream tier.
 *
 * Drives `opencode run --format json <prompt>` when the CLI is on PATH
 * (`curl -fsSL https://opencode.ai/install | bash`). Prefer the JSON event
 * stream over the SDK server for MVP — same BYO-auth model as other adapters.
 *
 * Approvals are CLI-owned until we wire the OpenCode permission protocol.
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
import { detectCli, interruptProcess, type TurnProcess } from "./shared/streamPump.ts";
import { normalizeOpenCodeStreamLine, type OpenCodeNormalizeState } from "./opencode/normalize.ts";

const log = logger("adapter:opencode");
const BINARY = "opencode";

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
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

export class OpenCodeAdapter implements ProviderAdapter {
  readonly kind = "opencode";
  readonly label = "OpenCode";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    return detectCli(
      BINARY,
      ["--version"],
      "opencode not on PATH — install from https://opencode.ai/install",
      "opencode exited non-zero — try `opencode auth login`",
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

    const args = ["run", "--format", "json", "--dir", session.cwd];
    if (session.nativeId) args.push("--session", session.nativeId);
    args.push(turn.text);

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
    void this.pump(session, proc, turn.turnId);
  }

  private async pump(session: Session, proc: TurnProcess, turnId: string) {
    let assistantText = "";
    let buffer = "";
    let normState: OpenCodeNormalizeState = { nativeId: session.nativeId, textLens: new Map() };

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
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
          const result = normalizeOpenCodeStreamLine(msg, turnId, normState);
          normState = result.state;
          if (normState.nativeId) session.nativeId = normState.nativeId;
          for (const event of result.events) session.emit(event);
          assistantText += result.text;
        }
      }

      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      if (code !== 0 && code !== null) {
        if (session.proc === proc) {
          session.emit({
            type: "error",
            code: "provider_failed",
            message: stderr.trim().split("\n").slice(-3).join(" ") || `opencode exited ${code}`,
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
