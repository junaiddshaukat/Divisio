/**
 * OpenAI-compatible chat completions adapter (BYOK).
 *
 * Talks HTTP directly — no vendor CLI. Used for custom endpoints the user
 * configures (OpenRouter, local vLLM, Azure OpenAI-compat, etc.).
 * Chat-only for now: no tool loop; sessions keep a short message history.
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

const log = logger("adapter:openai-compat");

export interface OpenAICompatConfig {
  /** Registry kind, e.g. `custom_abc123`. */
  kind: string;
  label: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Session extends SessionHandle {
  emit: EmitRuntimeEvent;
  messages: ChatMessage[];
  abort: AbortController | null;
  model: string;
}

const CAPABILITIES: AdapterCapabilities = {
  sessionResume: false,
  interruptTurn: true,
  modelSwitch: true,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function chatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly kind: string;
  readonly label: string;
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  private readonly config: OpenAICompatConfig;
  private readonly sessions = new Map<string, Session>();

  constructor(config: OpenAICompatConfig) {
    this.config = config;
    this.kind = config.kind;
    this.label = config.label;
  }

  get preferredModel(): string {
    return this.config.modelId;
  }

  async detect(): Promise<DetectResult> {
    const ok = !!this.config.baseUrl.trim() && !!this.config.apiKey.trim() && !!this.config.modelId.trim();
    return {
      available: ok,
      version: null,
      detail: ok ? null : "Set base URL, model id, and API key in Settings → Providers",
      authenticated: ok ? true : false,
      install: null,
      signIn: null,
    };
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    const session: Session = {
      threadId: input.threadId,
      nativeId: null,
      emit,
      messages: [
        {
          role: "system",
          content:
            "You are a coding assistant running inside Divisio. Help with the user's project. Be concrete; prefer editing files via clear instructions when you cannot run tools.",
        },
      ],
      abort: null,
      model: this.config.modelId,
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
    if (session.abort) throw new Error("turn already running");

    if (turn.model) session.model = turn.model;
    session.messages.push({ role: "user", content: turn.text });
    session.emit({ type: "status", status: "running" });

    const abort = new AbortController();
    session.abort = abort;

    void this.stream(session, turn.turnId, abort.signal);
  }

  private async stream(session: Session, turnId: string, signal: AbortSignal): Promise<void> {
    let assistant = "";
    try {
      const res = await fetch(chatCompletionsUrl(this.config.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: session.model,
          messages: session.messages,
          stream: true,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`);
      }

      if (!res.body) throw new Error("empty response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let parsed: {
            choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string } }>;
          };
          try {
            parsed = JSON.parse(data) as typeof parsed;
          } catch {
            continue;
          }
          const piece =
            parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
          if (!piece) continue;
          assistant += piece;
          session.emit({ type: "assistant.delta", turnId, text: piece });
        }
      }

      if (assistant) {
        session.messages.push({ role: "assistant", content: assistant });
        session.emit({ type: "assistant.message", turnId, text: assistant });
      } else {
        session.emit({
          type: "error",
          code: "empty_response",
          message: "The endpoint returned no assistant text",
        });
      }
      session.emit({ type: "turn.completed", turnId });
      session.emit({ type: "status", status: "ready" });
    } catch (err) {
      if (signal.aborted) {
        if (assistant) {
          session.messages.push({ role: "assistant", content: assistant });
          session.emit({ type: "assistant.message", turnId, text: assistant });
        }
        session.emit({ type: "turn.completed", turnId });
        session.emit({ type: "status", status: "ready" });
        return;
      }
      log.warn("openai-compat turn failed", { err: String(err) });
      // Drop the user message we just pushed if the call failed hard.
      const last = session.messages[session.messages.length - 1];
      if (last?.role === "user") session.messages.pop();
      session.emit({
        type: "error",
        code: "provider_failed",
        message: String(err),
      });
      session.emit({ type: "status", status: "error", detail: String(err) });
      session.emit({ type: "turn.completed", turnId });
      session.emit({ type: "status", status: "ready" });
    } finally {
      session.abort = null;
    }
  }

  async interruptTurn(handle: SessionHandle, _turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session?.abort) return;
    session.emit({ type: "status", status: "stopping" });
    session.abort.abort();
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    session.abort?.abort();
    this.sessions.delete(handle.threadId);
    session.emit({ type: "session.exited", code: null, signal: null });
  }
}
