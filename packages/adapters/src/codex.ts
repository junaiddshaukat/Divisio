/**
 * Codex adapter — Structured tier (`codex app-server` over NDJSON JSON-RPC).
 *
 * One long-lived process per session. Protocol:
 *   initialize → initialized → thread/start|resume → turn/start …
 *
 * Wire format omits `"jsonrpc":"2.0"`. Auth stays in the CLI; we never see a key.
 *
 * Spec: https://developers.openai.com/codex/app-server
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
import { PRODUCT_NAME, PRODUCT_SLUG } from "@divisio/shared/brand";
import { spawnWithEnv } from "@divisio/shared/spawn";
import { logger } from "@divisio/shared/log";
import {
  normalizeCodexApprovalRequest,
  normalizeCodexNotification,
  type CodexNormalizeState,
} from "./codex/normalize.ts";
import { JsonRpcStdioClient, type JsonRpcId, type JsonRpcInbound } from "./jsonrpc/stdio.ts";

const log = logger("adapter:codex");

const CAPABILITIES: AdapterCapabilities = {
  sessionResume: true,
  interruptTurn: true,
  modelSwitch: false,
  approvals: true,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

interface Session extends SessionHandle {
  cwd: string;
  emit: EmitRuntimeEvent;
  client: JsonRpcStdioClient | null;
  /** Codex thread id (also mirrored on nativeId). */
  codexThreadId: string | null;
  norm: CodexNormalizeState;
  /** Our turnId → Codex turn id for interrupt. */
  turnMap: Map<string, string>;
  /** Pending approval RPC ids awaiting respondToApproval. */
  pendingApprovals: Map<string, JsonRpcId>;
}

function extractThreadId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const thread = (result as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object") return null;
  const id = (thread as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function extractTurnId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const turn = (result as { turn?: unknown }).turn;
  if (!turn || typeof turn !== "object") return null;
  const id = (turn as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export class CodexAdapter implements ProviderAdapter {
  readonly kind = "codex";
  readonly label = "Codex";
  readonly tier = "structured" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly sessions = new Map<string, Session>();

  async detect(): Promise<DetectResult> {
    try {
      const proc = spawnWithEnv(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) {
        return {
          available: false,
          version: null,
          detail: "codex exited non-zero — try `codex login`",
        };
      }
      const version = (out.trim() || err.trim()).split(/\s+/).pop() ?? null;
      return { available: true, version, detail: null };
    } catch {
      return {
        available: false,
        version: null,
        detail: "codex not on PATH — install the Codex CLI",
      };
    }
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    const session: Session = {
      threadId: input.threadId,
      nativeId: null,
      cwd: input.cwd,
      emit,
      client: null,
      codexThreadId: null,
      norm: { turnId: null, codexTurnId: null, assistantText: "" },
      turnMap: new Map(),
      pendingApprovals: new Map(),
      close: async () => {
        await this.stopSession(session);
      },
    };
    this.sessions.set(input.threadId, session);
    emit({ type: "status", status: "connecting" });
    return this.bootSession(session, input);
  }

  private async bootSession(session: Session, input: StartSessionInput): Promise<SessionHandle> {
    try {
      const client = new JsonRpcStdioClient(["codex", "app-server"], {
        cwd: session.cwd,
        onMessage: (msg) => this.onInbound(session, msg),
        onClose: (code) => {
          if (this.sessions.has(session.threadId)) {
            session.emit({ type: "session.exited", code, signal: null });
            session.client = null;
            this.sessions.delete(session.threadId);
          }
        },
        onStderr: (chunk) => {
          const line = chunk.trim();
          if (line) log.warn("codex stderr", { sample: line.slice(0, 200) });
        },
      });
      session.client = client;

      await client.request("initialize", {
        clientInfo: {
          name: PRODUCT_SLUG,
          title: PRODUCT_NAME,
          version: "0.0.0",
        },
      });
      await client.notify("initialized");

      const threadParams = { cwd: session.cwd };
      let threadResult: unknown;
      if (input.resumeId) {
        try {
          threadResult = await client.request("thread/resume", {
            threadId: input.resumeId,
            ...threadParams,
          });
        } catch (err) {
          log.warn("thread/resume failed, falling back to thread/start", {
            threadId: session.threadId,
            detail: String(err),
          });
          threadResult = await client.request("thread/start", threadParams);
        }
      } else {
        threadResult = await client.request("thread/start", threadParams);
      }

      const codexThreadId = extractThreadId(threadResult);
      if (!codexThreadId) {
        throw new Error("codex thread/start returned no thread.id");
      }
      session.codexThreadId = codexThreadId;
      session.nativeId = codexThreadId;
      session.emit({ type: "status", status: "ready" });
      return session;
    } catch (err) {
      session.emit({
        type: "error",
        code: "provider_failed",
        message: String(err),
      });
      session.emit({ type: "status", status: "error", detail: String(err) });
      await this.stopSession(session);
      throw err;
    }
  }

  private onInbound(session: Session, msg: JsonRpcInbound): void {
    if (msg.kind === "notification") {
      const result = normalizeCodexNotification(msg.method, msg.params, session.norm);
      session.norm = result.state;
      if (result.state.codexTurnId && result.state.turnId) {
        session.turnMap.set(result.state.turnId, result.state.codexTurnId);
      }
      for (const event of result.events) session.emit(event);
      return;
    }

    if (msg.kind === "request") {
      const approvalId = String(msg.id);
      const event = normalizeCodexApprovalRequest(
        msg.method,
        msg.params,
        session.norm.turnId,
        approvalId,
      );
      if (event) {
        session.pendingApprovals.set(approvalId, msg.id);
        session.emit({ type: "status", status: "awaiting_approval" });
        session.emit(event);
        return;
      }
      // Unknown server request — decline so the turn does not hang forever.
      log.warn("unhandled codex server request", { method: msg.method });
      void session.client?.respond(msg.id, "cancel").catch(() => undefined);
    }
  }

  async sendTurn(handle: SessionHandle, turn: SendTurnInput): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session?.client || !session.codexThreadId) {
      throw new Error(`no codex session for thread ${handle.threadId}`);
    }
    if (session.norm.turnId) {
      throw new Error("turn already running");
    }

    session.norm = {
      turnId: turn.turnId,
      codexTurnId: null,
      assistantText: "",
    };

    log.info("starting turn", {
      threadId: session.threadId,
      turnId: turn.turnId,
      codexThreadId: session.codexThreadId,
    });

    session.emit({ type: "status", status: "running" });

    try {
      const result = await session.client.request("turn/start", {
        threadId: session.codexThreadId,
        input: [{ type: "text", text: turn.text }],
      });
      const codexTurnId = extractTurnId(result);
      if (codexTurnId) {
        session.norm = { ...session.norm, codexTurnId };
        session.turnMap.set(turn.turnId, codexTurnId);
      }
    } catch (err) {
      session.norm = { turnId: null, codexTurnId: null, assistantText: "" };
      session.emit({
        type: "error",
        code: "provider_failed",
        message: String(err),
      });
      session.emit({ type: "status", status: "error", detail: String(err) });
      session.emit({ type: "turn.completed", turnId: turn.turnId });
      session.emit({ type: "status", status: "ready" });
    }
  }

  async interruptTurn(handle: SessionHandle, turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session?.client || !session.codexThreadId) return;

    const codexTurnId =
      session.turnMap.get(turnId) ??
      (session.norm.turnId === turnId ? session.norm.codexTurnId : null);
    if (!codexTurnId) return;

    session.emit({ type: "status", status: "stopping" });

    try {
      await session.client.request("turn/interrupt", {
        threadId: session.codexThreadId,
        turnId: codexTurnId,
      });
    } catch (err) {
      log.warn("turn/interrupt failed", { detail: String(err) });
      // Fall through — turn/completed may still arrive, or we force-complete.
      session.emit({ type: "turn.completed", turnId });
      session.norm = { turnId: null, codexTurnId: null, assistantText: "" };
      session.emit({ type: "status", status: "ready" });
    }
  }

  async respondToApproval(
    handle: SessionHandle,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session?.client) return;

    const rpcId = session.pendingApprovals.get(approvalId);
    if (rpcId === undefined) {
      log.warn("approval response for unknown id", { approvalId });
      return;
    }
    session.pendingApprovals.delete(approvalId);

    // Codex decisions: accept | decline | cancel | acceptForSession
    const result = decision === "approve" ? "accept" : "decline";
    await session.client.respond(rpcId, result);
    session.emit({ type: "status", status: "running" });
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    this.sessions.delete(handle.threadId);

    // Auto-decline outstanding approvals so Codex does not hang on exit.
    for (const [approvalId, rpcId] of session.pendingApprovals) {
      try {
        await session.client?.respond(rpcId, "cancel");
      } catch {
        /* ignore */
      }
      session.pendingApprovals.delete(approvalId);
    }

    if (session.client) {
      await session.client.close();
      session.client = null;
    }
    session.emit({ type: "session.exited", code: null, signal: null });
  }
}
