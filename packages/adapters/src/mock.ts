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

/**
 * In-process mock peer for tests — the T3-style fixture pattern.
 *
 * No live CLI. Turns complete from scripted events so orchestration,
 * interrupt → stopping, and capability wiring can be asserted without
 * depending on vendor binaries or network auth.
 */

export interface MockPeerOptions {
  /** Delay before scripted turn events fire (lets interrupt win the race). */
  turnDelayMs?: number;
  /** Extra events after the initial delta, before turn.completed. */
  script?: Array<
    | { type: "assistant.delta"; text: string }
    | { type: "assistant.message"; text: string }
    | { type: "status"; status: "running" | "ready" | "stopping" }
  >;
}

interface MockSession extends SessionHandle {
  emit: EmitRuntimeEvent;
  cwd: string;
  activeTurnId: string | null;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
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

export class MockPeerAdapter implements ProviderAdapter {
  readonly kind = "mock";
  readonly label = "Mock Peer";
  readonly tier = "stream" as const;
  readonly capabilities = CAPABILITIES;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  /** Status values emitted in order — tests assert interrupt reaches `stopping`. */
  readonly statusLog: string[] = [];

  private readonly sessions = new Map<string, MockSession>();
  private readonly turnDelayMs: number;
  private readonly script: NonNullable<MockPeerOptions["script"]>;

  constructor(options: MockPeerOptions = {}) {
    this.turnDelayMs = options.turnDelayMs ?? 50;
    this.script = options.script ?? [
      { type: "assistant.delta", text: "hello " },
      { type: "assistant.delta", text: "world" },
      { type: "assistant.message", text: "hello world" },
    ];
  }

  async detect(): Promise<DetectResult> {
    return { available: true, version: "test", detail: null };
  }

  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    const session: MockSession = {
      threadId: input.threadId,
      nativeId: input.resumeId ?? "mock-native-1",
      cwd: input.cwd,
      emit,
      activeTurnId: null,
      cancelled: false,
      timer: null,
      close: async () => {
        await this.stopSession(session);
      },
    };
    this.sessions.set(input.threadId, session);
    this.recordStatus(session, "ready");
    return session;
  }

  async sendTurn(handle: SessionHandle, turn: SendTurnInput): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) throw new Error(`no mock session for ${handle.threadId}`);
    if (session.activeTurnId) throw new Error("turn already running");

    session.activeTurnId = turn.turnId;
    session.cancelled = false;
    this.recordStatus(session, "running");

    session.timer = setTimeout(() => {
      session.timer = null;
      if (session.cancelled || session.activeTurnId !== turn.turnId) return;

      for (const step of this.script) {
        if (session.cancelled) return;
        if (step.type === "assistant.delta") {
          session.emit({ type: "assistant.delta", turnId: turn.turnId, text: step.text });
        } else if (step.type === "assistant.message") {
          session.emit({ type: "assistant.message", turnId: turn.turnId, text: step.text });
        } else if (step.type === "status") {
          this.recordStatus(session, step.status);
        }
      }

      if (session.cancelled || session.activeTurnId !== turn.turnId) return;
      session.activeTurnId = null;
      session.emit({ type: "turn.completed", turnId: turn.turnId });
      this.recordStatus(session, "ready");
    }, this.turnDelayMs);
  }

  async interruptTurn(handle: SessionHandle, turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session || session.activeTurnId !== turnId) return;

    // Same contract as Claude: report stopping before claiming ready.
    this.recordStatus(session, "stopping");
    session.cancelled = true;
    session.activeTurnId = null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    session.emit({ type: "turn.completed", turnId });
    this.recordStatus(session, "ready");
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    session.cancelled = true;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(handle.threadId);
    session.emit({ type: "session.exited", code: null, signal: null });
  }

  private recordStatus(session: MockSession, status: "ready" | "running" | "stopping") {
    this.statusLog.push(status);
    session.emit({ type: "status", status });
  }
}
