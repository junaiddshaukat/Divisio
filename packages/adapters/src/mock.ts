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
 * In-process mock peer for tests — fixture pattern, not a live CLI.
 *
 * No live CLI. Turns complete from scripted events so orchestration,
 * interrupt → stopping, approvals, and capability wiring can be asserted
 * without depending on vendor binaries or network auth.
 */

export type MockScriptStep =
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.message"; text: string }
  | { type: "status"; status: "ready" | "running" | "stopping" | "awaiting_approval" }
  | {
      type: "approval.requested";
      approvalId: string;
      category: string;
      summary: string;
      /** Wait for respondToApproval before continuing the script. */
      wait?: boolean;
    }
  | {
      type: "usage.reported";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };

export interface MockPeerOptions {
  turnDelayMs?: number;
  script?: MockScriptStep[];
  /** When true, declare approvals capability (for supervised-mode tests). */
  approvals?: boolean;
  /** Default true. Set false to assert we do not pass resumeId. */
  sessionResume?: boolean;
  /** Throw from startSession when resumeId is set. */
  failResume?: boolean;
}

interface MockSession extends SessionHandle {
  emit: EmitRuntimeEvent;
  cwd: string;
  activeTurnId: string | null;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolve when respondToApproval is called for this id. */
  approvalWaiters: Map<string, (decision: "approve" | "deny") => void>;
}

const BASE_CAPABILITIES: AdapterCapabilities = {
  sessionResume: true,
  interruptTurn: true,
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

export class MockPeerAdapter implements ProviderAdapter {
  // Typed as string, not as the literal "mock": ProviderAdapter declares
  // `kind: ProviderKind` (a string), and inferring a literal here stops tests
  // from subclassing this to get a second provider.
  readonly kind: string = "mock";
  readonly label: string = "Mock Peer";
  readonly tier = "stream" as const;
  readonly capabilities: AdapterCapabilities;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  readonly statusLog: string[] = [];
  readonly approvalLog: Array<{ approvalId: string; decision: "approve" | "deny" }> = [];
  /** Inputs passed to startSession, in call order — used to assert resume. */
  readonly startInputs: StartSessionInput[] = [];

  private readonly sessions = new Map<string, MockSession>();
  private readonly turnDelayMs: number;
  private readonly script: MockScriptStep[];
  private readonly failResume: boolean;

  constructor(options: MockPeerOptions = {}) {
    this.turnDelayMs = options.turnDelayMs ?? 50;
    this.failResume = options.failResume === true;
    this.capabilities = {
      ...BASE_CAPABILITIES,
      approvals: options.approvals ?? false,
      sessionResume: options.sessionResume ?? true,
    };
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
    this.startInputs.push(input);
    if (this.failResume && input.resumeId) {
      throw new Error("vendor refused resume");
    }
    const session: MockSession = {
      threadId: input.threadId,
      nativeId: input.resumeId ?? "mock-native-1",
      cwd: input.cwd,
      emit,
      activeTurnId: null,
      cancelled: false,
      timer: null,
      approvalWaiters: new Map(),
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
      void this.runScript(session, turn.turnId);
    }, this.turnDelayMs);
  }

  private async runScript(session: MockSession, turnId: string) {
    for (const step of this.script) {
      if (session.cancelled || session.activeTurnId !== turnId) return;

      if (step.type === "assistant.delta") {
        session.emit({ type: "assistant.delta", turnId, text: step.text });
      } else if (step.type === "assistant.message") {
        session.emit({ type: "assistant.message", turnId, text: step.text });
      } else if (step.type === "status") {
        this.recordStatus(session, step.status);
      } else if (step.type === "approval.requested") {
        // Register the waiter before emit — full_access auto-approve may
        // respond synchronously inside onRuntimeEvent.
        let decisionPromise: Promise<"approve" | "deny"> | null = null;
        if (step.wait !== false) {
          decisionPromise = new Promise<"approve" | "deny">((resolve) => {
            session.approvalWaiters.set(step.approvalId, resolve);
          });
        }
        session.emit({
          type: "approval.requested",
          turnId,
          approvalId: step.approvalId,
          category: step.category,
          summary: step.summary,
        });
        this.recordStatus(session, "awaiting_approval");
        if (decisionPromise) {
          await decisionPromise;
          if (session.cancelled || session.activeTurnId !== turnId) return;
          this.recordStatus(session, "running");
        }
      } else if (step.type === "usage.reported") {
        session.emit({
          type: "usage.reported",
          turnId,
          ...(step.inputTokens !== undefined ? { inputTokens: step.inputTokens } : {}),
          ...(step.outputTokens !== undefined ? { outputTokens: step.outputTokens } : {}),
          ...(step.totalTokens !== undefined ? { totalTokens: step.totalTokens } : {}),
        });
      }
    }

    if (session.cancelled || session.activeTurnId !== turnId) return;
    session.activeTurnId = null;
    session.emit({ type: "turn.completed", turnId });
    this.recordStatus(session, "ready");
  }

  async respondToApproval(
    handle: SessionHandle,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session) return;
    this.approvalLog.push({ approvalId, decision });
    const waiter = session.approvalWaiters.get(approvalId);
    if (waiter) {
      session.approvalWaiters.delete(approvalId);
      waiter(decision);
    }
  }

  async interruptTurn(handle: SessionHandle, turnId: string): Promise<void> {
    const session = this.sessions.get(handle.threadId);
    if (!session || session.activeTurnId !== turnId) return;

    this.recordStatus(session, "stopping");
    session.cancelled = true;
    session.activeTurnId = null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    for (const [, resolve] of session.approvalWaiters) resolve("deny");
    session.approvalWaiters.clear();
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

  private recordStatus(
    session: MockSession,
    status: "ready" | "running" | "stopping" | "awaiting_approval",
  ) {
    this.statusLog.push(status);
    session.emit({ type: "status", status });
  }
}
