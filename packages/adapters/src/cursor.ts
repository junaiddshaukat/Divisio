/**
 * Cursor Agent adapter — Structured tier when the CLI supports it, Stream tier
 * otherwise.
 *
 * Two transports, chosen by probe rather than by assumption:
 *
 * - **Agent Client Protocol** (`cursor-agent acp`). A long-lived agent process
 *   per thread, so a turn costs a protocol call instead of a CLI cold boot, and
 *   the agent asks permission before dangerous tool calls. This is the only
 *   transport that can honestly declare `approvals`.
 * - **Print mode** (`--print --output-format stream-json`). One process per
 *   turn, permissions owned by the CLI. Kept as the fallback so an older CLI
 *   keeps working rather than breaking on upgrade.
 *
 * Capabilities follow the resolved transport: `detect()` probes first, and the
 * orchestrator reads `capabilities` afterwards. A capability that is true only
 * on one transport must never be declared while the other is in use — that is
 * how a button that decides nothing ends up in the UI.
 *
 * Auth stays in the CLI (`cursor-agent login`); we never see a key.
 * Prefer `cursor-agent` over bare `agent` — on many machines `agent` is Grok.
 *
 * Spec: https://cursor.com/docs/cli/reference/output-format
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
import { spawnWithEnv, terminateSubprocess } from "@divisio/shared/spawn";
import { type CursorNormalizeState, normalizeCursorStreamLine } from "./cursor/normalize.ts";
import { pushModelArg } from "./shared/modelArg.ts";
import type { AcpSession } from "./acp/session.ts";
import { AcpTransport } from "./acp/transport.ts";

const log = logger("adapter:cursor");

const BINARY = "cursor-agent";

type TurnProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface Session extends SessionHandle {
  proc: TurnProcess | null;
  cwd: string;
  emit: EmitRuntimeEvent;
  nativeId: string | null;
  /** Divisio's mode for this thread, mapped onto the CLI's own gate. */
  permissionMode: PermissionMode;
  /** Set only on the ACP transport; null means this session is print-mode. */
  acp: AcpSession | null;
}

/** argv that starts the CLI as an ACP agent. */
const ACP_COMMAND = [BINARY, "acp"];

const BASE_CAPABILITIES: AdapterCapabilities = {
  sessionResume: true,
  interruptTurn: true,
  modelSwitch: true,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

export class CursorAdapter implements ProviderAdapter {
  readonly kind = "cursor";
  readonly label = "Cursor Agent";
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();
  private readonly acp = new AcpTransport(ACP_COMMAND);

  get tier(): "structured" | "stream" {
    return this.acp.tier;
  }

  get capabilities(): AdapterCapabilities {
    return this.acp.capabilities(BASE_CAPABILITIES);
  }

  async detect(): Promise<DetectResult> {
    try {
      const proc = spawnWithEnv([BINARY, "--version"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) {
        return {
          available: false,
          version: null,
          detail: "cursor-agent exited non-zero — try `cursor-agent login`",
        };
      }
      const version = (out.trim() || err.trim()).split(/\s+/).pop() ?? null;
      this.acp.noteDetect();
      return { available: true, version, detail: null };
    } catch {
      return {
        available: false,
        version: null,
        detail: "cursor-agent not on PATH — install the Cursor Agent CLI",
      };
    }
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    const session: Session = {
      threadId: input.threadId,
      permissionMode: input.permissionMode ?? "supervised",
      nativeId: input.resumeId ?? null,
      proc: null,
      acp: null,
      cwd: input.cwd,
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
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--workspace",
      session.cwd,
    ];

    // Without this the CLI refuses mutating commands in print mode, so a
    // full-access thread could talk but never change a file. Supervised threads
    // deliberately omit it and the CLI's own gate applies.
    if (session.permissionMode === "full_access") args.push("--force");
    if (session.nativeId) args.push("--resume", session.nativeId);
    pushModelArg(args, turn.model);
    args.push(turn.text);

    log.info("spawning turn", {
      threadId: session.threadId,
      turnId: turn.turnId,
      resume: !!session.nativeId,
    });

    const proc = Bun.spawn({
      cmd: [BINARY, ...args],
      cwd: session.cwd,
      // See claude.ts: PATH repair only applies when env is passed explicitly.
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
    let normState: CursorNormalizeState = { nativeId: session.nativeId, seenPartial: false };

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
          const result = normalizeCursorStreamLine(msg, turnId, normState);
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
            message:
              stderr.trim().split("\n").slice(-3).join(" ") || `cursor-agent exited ${code}`,
          });
        }
      } else if (assistantText.length > 0 && session.proc === proc) {
        session.emit({ type: "assistant.message", turnId, text: assistantText });
      }
    } catch (err) {
      // Gated like the exit path above. `interruptTurn` nulls `session.proc`
      // before killing, so a stopped pump is never current — an ungated emit
      // here was attributed to whatever turn started next and failed it.
      if (session.proc === proc) {
        session.emit({ type: "error", code: "stream_failed", message: String(err) });
      }
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
    if (!session) return;

    if (session.acp) {
      // Cancelling over the protocol keeps the agent warm, so Stop does not
      // cost the next turn a cold boot.
      await session.acp.cancel(turnId);
      return;
    }

    const proc = session.proc;
    if (!proc) return;

    session.emit({ type: "status", status: "stopping" });
    session.proc = null;
    await terminateSubprocess(proc);

    session.emit({ type: "turn.completed", turnId });
    session.emit({ type: "status", status: "ready" });
  }

  /** Only reachable on the ACP transport; print mode declares no approvals. */
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
