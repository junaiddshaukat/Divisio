/**
 * Agent Client Protocol session driver.
 *
 * One long-lived agent subprocess per thread. Turns are protocol calls on that
 * process, so a turn never pays a CLI cold boot, and the agent asks us before
 * running a dangerous tool instead of deciding on its own.
 *
 * Provider-agnostic on purpose: the only per-provider input is the argv used to
 * start the agent. Adapters compose this rather than reimplementing the
 * protocol, so a second ACP-capable CLI costs an argv and a `detect()`.
 */

import type { EmitRuntimeEvent, ProviderRuntimeEvent } from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { JsonRpcStdioClient, type JsonRpcId, type JsonRpcInbound } from "../jsonrpc/stdio.ts";
import {
  newAcpState,
  normalizeAcpPermissionRequest,
  normalizeAcpUpdate,
  selectAcpOptionId,
  type AcpNormalizeState,
  type AcpPermissionOption,
} from "./normalize.ts";

const log = logger("adapter:acp");

/** ACP revision this client implements. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * What this client can actually do for the agent.
 *
 * Declared from what is implemented, not from what would be convenient. We do
 * not serve `fs/read_text_file` or `fs/write_text_file`, so claiming them made
 * the agent route file edits through us, get an error back, and fall back to
 * shell — slower, and it turned a file write into a shell command the user then
 * had to reason about. The agent uses its own file tools instead.
 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
} as const;

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: Record<string, unknown> };
  authMethods?: { id: string; name?: string; description?: string }[];
}

interface PendingPermission {
  rpcId: JsonRpcId;
  options: AcpPermissionOption[];
}

export interface AcpSessionOptions {
  /** argv that starts the agent in ACP mode. */
  cmd: string[];
  cwd: string;
  emit: EmitRuntimeEvent;
  /** Called when the agent process exits on its own. */
  onExit?: (code: number | null, signal: string | null) => void;
  /**
   * Called the first time this agent asks permission for a tool call.
   *
   * Whether an agent asks is its own policy, not a property of the protocol —
   * some run their tools and never ask. Observing one real request is the only
   * honest evidence that supervision means anything here.
   */
  onMediationObserved?: () => void;
}

/**
 * Thrown when the agent reports that the user has not signed in.
 *
 * Distinct from a generic protocol failure so the adapter can surface the
 * vendor's own sign-in instruction rather than a stack trace.
 */
export class AcpAuthRequiredError extends Error {
  constructor(
    message: string,
    readonly methods: { id: string; name?: string; description?: string }[],
  ) {
    super(message);
    this.name = "AcpAuthRequiredError";
  }
}

function isAuthRequired(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /auth/i.test(text) && /require|login|sign.?in/i.test(text);
}

export class AcpSession {
  private client: JsonRpcStdioClient | null = null;
  private sessionId: string | null = null;
  private authMethods: { id: string; name?: string; description?: string }[] = [];
  private activeTurnId: string | null = null;
  private assistantText = "";
  private norm: AcpNormalizeState = newAcpState();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private approvalSeq = 0;
  /**
   * Turn ids already reported finished.
   *
   * Only one turn runs at a time, so this is cleared per turn rather than
   * accumulated — a session that serves hundreds of turns would otherwise hold
   * a string for every one of them.
   */
  private readonly settled = new Set<string>();

  constructor(private readonly options: AcpSessionOptions) {}

  get nativeId(): string | null {
    return this.sessionId;
  }

  get currentTurnId(): string | null {
    return this.activeTurnId;
  }

  /** Start the agent process and complete the protocol handshake. */
  async start(): Promise<AcpInitializeResult> {
    const client = new JsonRpcStdioClient(this.options.cmd, {
      includeJsonrpc: true,
      cwd: this.options.cwd,
      onMessage: (msg) => this.onInbound(msg),
      onClose: (code, signal) => this.onClose(code, signal),
      onStderr: (chunk) => log.debug("agent stderr", { sample: chunk.slice(0, 200) }),
    });
    this.client = client;

    const init = await client.request<AcpInitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    this.authMethods = init?.authMethods ?? [];
    return init ?? {};
  }

  /**
   * Open a conversation, authenticating first if the agent demands it.
   *
   * Auth is attempted exactly once: if the vendor still refuses, the user has
   * to run the CLI's own login, and saying so is more useful than retrying.
   */
  async openConversation(): Promise<string> {
    try {
      return await this.newSession();
    } catch (err) {
      if (!isAuthRequired(err)) throw err;
      const method = this.authMethods[0];
      if (!method) {
        throw new AcpAuthRequiredError(
          "the agent requires sign-in but offered no method",
          this.authMethods,
        );
      }
      log.info("authenticating with agent", { methodId: method.id });
      try {
        await this.client?.request("authenticate", { methodId: method.id });
      } catch (authErr) {
        throw new AcpAuthRequiredError(String(authErr), this.authMethods);
      }
      return await this.newSession();
    }
  }

  private async newSession(): Promise<string> {
    const result = await this.client?.request<{ sessionId?: string }>("session/new", {
      cwd: this.options.cwd,
      mcpServers: [],
    });
    const id = result?.sessionId;
    if (typeof id !== "string" || !id) throw new Error("agent returned no session id");
    this.sessionId = id;
    return id;
  }

  /**
   * Resume a prior conversation. Only valid when the agent advertises it.
   *
   * Takes the same shape as opening a new one, plus the id. Omitting
   * `mcpServers` is rejected as invalid params, and the failure is
   * indistinguishable from an expired session — which silently cost the user
   * the whole conversation on every reopen.
   */
  async loadConversation(sessionId: string): Promise<void> {
    await this.client?.request("session/load", {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionId;
  }

  /**
   * Run one turn.
   *
   * Resolves when the agent reports the turn finished. The prompt call is not
   * awaited by the caller — turn completion is reported through `emit`, the
   * same as every other tier.
   */
  sendTurn(turnId: string, text: string): void {
    if (!this.client || !this.sessionId) throw new Error("acp session not started");
    if (this.activeTurnId) throw new Error("turn already running");

    this.activeTurnId = turnId;
    this.assistantText = "";
    this.norm = newAcpState();
    this.settled.clear();
    this.options.emit({ type: "status", status: "running" });

    void this.client
      .request<{ stopReason?: string }>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      })
      .then((result) => {
        // `cancelled` is the agent acknowledging our own cancel, not a failure.
        const reason = result?.stopReason;
        if (reason && reason !== "end_turn" && reason !== "cancelled") {
          log.info("turn ended early", { turnId, reason });
        }
        this.settleTurn(turnId);
      })
      .catch((err) => {
        if (this.activeTurnId !== turnId) return;
        this.options.emit({ type: "error", code: "provider_failed", message: String(err) });
        this.settleTurn(turnId);
      });
  }

  /** Ask the agent to stop the running turn. Keeps the process warm. */
  async cancel(turnId: string): Promise<void> {
    if (this.activeTurnId !== turnId) return;
    this.options.emit({ type: "status", status: "stopping" });
    // Outstanding permission requests block the agent; answer them or the
    // cancel cannot be acted on.
    await this.declineAllPending();
    try {
      await this.client?.notify("session/cancel", { sessionId: this.sessionId });
    } catch (err) {
      log.warn("cancel failed", { detail: String(err) });
      this.settleTurn(turnId);
    }
    // The agent answers a cancel by resolving session/prompt with
    // `stopReason: "cancelled"`, which settles the turn through the normal path.
  }

  /** Answer one outstanding permission request. */
  async respondToApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    const pending = this.pendingPermissions.get(approvalId);
    if (!pending) return;
    this.pendingPermissions.delete(approvalId);

    const optionId = selectAcpOptionId(pending.options, decision);
    const outcome = optionId
      ? { outcome: "selected" as const, optionId }
      : { outcome: "cancelled" as const };
    await this.client?.respond(pending.rpcId, { outcome });
    if (this.activeTurnId) this.options.emit({ type: "status", status: "running" });
  }

  /** Cancel every outstanding permission request so the agent stops waiting. */
  private async declineAllPending(): Promise<void> {
    const outstanding = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    for (const pending of outstanding) {
      try {
        await this.client?.respond(pending.rpcId, { outcome: { outcome: "cancelled" } });
      } catch (err) {
        log.warn("failed to cancel permission request", { detail: String(err) });
      }
    }
  }

  private onInbound(msg: JsonRpcInbound): void {
    if (msg.kind === "notification") {
      if (msg.method !== "session/update") return;
      const turnId = this.activeTurnId;
      if (!turnId) return;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const update = params["update"];
      if (!update || typeof update !== "object") return;
      const result = normalizeAcpUpdate(update as Record<string, unknown>, turnId, this.norm);
      for (const event of result.events) this.options.emit(event);
      this.assistantText += result.text;
      return;
    }

    if (msg.kind === "request") {
      if (msg.method === "session/request_permission") {
        this.onPermissionRequest(msg.id, (msg.params ?? {}) as Record<string, unknown>);
        return;
      }
      // Every agent request must be answered; an unhandled one stalls the turn.
      log.warn("unhandled agent request", { method: msg.method });
      void this.client?.respondError(msg.id, -32601, "unsupported by Divisio").catch(() => undefined);
    }
  }

  private onPermissionRequest(rpcId: JsonRpcId, params: Record<string, unknown>): void {
    const turnId = this.activeTurnId;
    if (!turnId) {
      void this.client?.respond(rpcId, { outcome: { outcome: "cancelled" } }).catch(() => undefined);
      return;
    }
    const approvalId = `acp_${++this.approvalSeq}`;
    const mapped = normalizeAcpPermissionRequest(params, turnId, approvalId);
    if (!mapped) {
      // Nothing presentable — cancel rather than show a control that lies.
      void this.client?.respond(rpcId, { outcome: { outcome: "cancelled" } }).catch(() => undefined);
      return;
    }
    this.pendingPermissions.set(approvalId, { rpcId, options: mapped.options });
    this.options.onMediationObserved?.();
    this.options.emit({ type: "status", status: "awaiting_approval" });
    this.options.emit(mapped.event);
  }

  /** Report turn end exactly once, flushing accumulated assistant text. */
  private settleTurn(turnId: string): void {
    if (this.activeTurnId !== turnId || this.settled.has(turnId)) return;
    this.settled.add(turnId);
    const text = this.assistantText;
    this.activeTurnId = null;
    this.assistantText = "";
    this.pendingPermissions.clear();
    const events: ProviderRuntimeEvent[] = [];
    if (text.length > 0) events.push({ type: "assistant.message", turnId, text });
    events.push({ type: "turn.completed", turnId });
    events.push({ type: "status", status: "ready" });
    for (const event of events) this.options.emit(event);
  }

  private onClose(code: number | null, signal: string | null): void {
    this.client = null;
    const turnId = this.activeTurnId;
    if (turnId) {
      this.options.emit({
        type: "error",
        code: "provider_failed",
        message: `agent exited (${code ?? signal ?? "unknown"})`,
      });
      this.settleTurn(turnId);
    }
    this.options.onExit?.(code, signal);
  }

  async close(): Promise<void> {
    await this.declineAllPending();
    const client = this.client;
    this.client = null;
    this.activeTurnId = null;
    await client?.close();
  }
}
