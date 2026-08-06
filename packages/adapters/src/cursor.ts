/**
 * Cursor Agent adapter — Stream tier.
 *
 * Drives `cursor-agent` in `--print --output-format stream-json` mode with
 * `--stream-partial-output` for character-level deltas. One process per turn.
 * Auth stays in the CLI (`cursor-agent login`); we never see a key.
 *
 * Prefer `cursor-agent` over bare `agent` — on many machines `agent` is Grok.
 *
 * `approvals` is false: print mode owns the permission engine. Mediated
 * approvals need the ACP transport (`cursor-agent acp`) — a later Structured upgrade.
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
  type SessionHandle,
  type StartSessionInput,
} from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { spawnWithEnv } from "@divisio/shared/spawn";
import { type CursorNormalizeState, normalizeCursorStreamLine } from "./cursor/normalize.ts";

const log = logger("adapter:cursor");

const BINARY = "cursor-agent";

type TurnProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface Session extends SessionHandle {
  proc: TurnProcess | null;
  cwd: string;
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

export class CursorAdapter implements ProviderAdapter {
  readonly kind = "cursor";
  readonly label = "Cursor Agent";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

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
      nativeId: input.resumeId ?? null,
      proc: null,
      cwd: input.cwd,
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
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--workspace",
      session.cwd,
    ];
    if (session.nativeId) args.push("--resume", session.nativeId);
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
