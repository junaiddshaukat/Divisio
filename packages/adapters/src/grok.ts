/**
 * Grok Build (xAI) adapter — Structured tier when the CLI supports it, Stream
 * tier otherwise.
 *
 * The CLI can run as an agent over stdio, which keeps one process per thread
 * and asks before dangerous tool calls. That is the preferred transport: turns
 * become protocol calls instead of a fresh CLI each time, and approvals become
 * something Divisio can actually mediate.
 *
 * The `-p … --output-format streaming-json` path stays as the fallback for a
 * CLI without it. Current CLIs emit `{type:"text",data}` token deltas; older
 * Messages-shaped NDJSON still maps. Prefer binary `grok` (not bare `agent`).
 *
 * On the fallback, full-access threads pass `--always-approve` and approvals
 * remain CLI-owned. Capabilities follow the transport actually in use.
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
import { terminateSubprocess } from "@divisio/shared/spawn";
import { detectCli, interruptProcess, pumpClaudeLikeStream, type TurnProcess } from "./shared/streamPump.ts";
import { pushModelArg } from "./shared/modelArg.ts";
import { normalizeGrokStreamLine } from "./grok/normalize.ts";
import type { AcpSession } from "./acp/session.ts";
import { AcpTransport } from "./acp/transport.ts";

const log = logger("adapter:grok");
const BINARY = "grok";

interface Session extends SessionHandle {
  proc: TurnProcess | null;
  cwd: string;
  permissionMode: PermissionMode;
  emit: EmitRuntimeEvent;
  nativeId: string | null;
  /** Set only on the protocol transport; null means this session is print-mode. */
  acp: AcpSession | null;
}

/** argv that runs the CLI as an agent over stdio. */
const ACP_COMMAND = [BINARY, "agent", "stdio"];

const BASE_CAPABILITIES: AdapterCapabilities = {
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
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();
  private readonly acp = new AcpTransport(ACP_COMMAND, {
    // Observed running tools without ever sending a permission request, and
    // the stdio agent exposes no approval-policy option. The protocol still
    // buys a warm session; it does not buy supervision here.
    mediatesApprovals: false,
  });

  get tier(): "structured" | "stream" {
    return this.acp.tier;
  }

  get capabilities(): AdapterCapabilities {
    return this.acp.capabilities(BASE_CAPABILITIES);
  }

  async detect(): Promise<DetectResult> {
    const result = await detectCli(
      BINARY,
      ["version"],
      "grok not on PATH — install the xAI Grok Build CLI",
      "grok exited non-zero — try `grok` auth / login",
    );
    if (result.available) this.acp.noteDetect();
    return result;
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    const session: Session = {
      threadId: input.threadId,
      nativeId: input.resumeId ?? null,
      proc: null,
      acp: null,
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "supervised",
      emit,
      close: async () => {
        await this.stopSession(session);
      },
    };
    this.sessions.set(input.threadId, session);

    const opened = await this.acp.open({
      cwd: input.cwd,
      emit,
      resumeId: input.resumeId ?? null,
      threadId: input.threadId,
      onExit: (dead) => {
        if (session.acp === dead) session.acp = null;
      },
    });
    if (opened) {
      session.acp = opened.session;
      session.nativeId = opened.nativeId;
    }

    emit({ type: "status", status: "ready" });
    return session;
  }

  async sendTurn(handle: SessionHandle, turn: SendTurnInput): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) throw new Error(`no session for thread ${handle.threadId}`);
    if (session.proc) throw new Error("turn already running");

    if (session.acp) {
      session.acp.sendTurn(turn.turnId, turn.text);
      return;
    }

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
    if (!session) return;

    if (session.acp) {
      // Cancelling over the protocol keeps the agent warm, so Stop does not
      // cost the next turn a cold boot.
      await session.acp.cancel(turnId);
      return;
    }

    const proc = session.proc;
    if (!proc) return;
    session.proc = null;
    await interruptProcess(proc, session.emit, turnId);
  }

  /** Only reachable on the protocol transport; print mode declares no approvals. */
  async respondToApproval(
    handle: SessionHandle,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    await session?.acp?.respondToApproval(approvalId, decision);
  }

  /** Divisio's permission mode changed; apply it without losing the session. */
  setPermissionMode(handle: SessionHandle, mode: PermissionMode): void {
    const session = this.sessions.get(handle.threadId);
    if (session) session.permissionMode = mode;
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    if (session.acp) {
      await session.acp.close();
      session.acp = null;
    }
    if (session.proc) {
      await terminateSubprocess(session.proc, 500);
    }
    this.sessions.delete(handle.threadId);
    session.emit({ type: "session.exited", code: null, signal: null });
  }
}
