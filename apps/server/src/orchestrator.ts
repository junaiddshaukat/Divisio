import {
  CommandError,
  type CommandName,
  type CommandPayloads,
  type CommandResults,
  type DomainEvent,
  type NewEvent,
  type ProviderRuntimeEvent,
  type SessionHandle,
} from "@divisio/contracts";
import type { AdapterRegistry } from "@divisio/adapters";
import { newId } from "@divisio/shared/ids";
import { logger } from "@divisio/shared/log";
import { existsSync } from "node:fs";
import type { EventStore } from "./store/log.ts";

const log = logger("orchestrator");

export interface Broadcaster {
  events(events: DomainEvent[]): void;
  delta(threadId: string, turnId: string, text: string): void;
}

interface LiveSession {
  handle: SessionHandle;
  provider: string;
  activeTurnId: string | null;
}

/**
 * Turns client commands into events and drives adapters.
 *
 * Plain modules, no decider/projector/reactor ceremony (ADR 0004). The
 * append-only log is what is load-bearing; the framework around it was not.
 */
export class Orchestrator {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly store: EventStore,
    private readonly registry: AdapterRegistry,
    private readonly bus: Broadcaster,
  ) {}

  async dispatch<C extends CommandName>(cmd: C, payload: CommandPayloads[C]): Promise<CommandResults[C]> {
    // Routed untyped, cast once at the boundary. Narrowing a generic C inside a
    // switch does not relate the payload and result types, so per-case casts
    // just move the same unsoundness around while reading as if they were safe.
    return (await this.route(cmd, payload as never)) as CommandResults[C];
  }

  private async route(cmd: CommandName, payload: never): Promise<unknown> {
    switch (cmd) {
      case "project.create":
        return this.createProject(payload);
      case "project.list":
        return { projects: this.store.listProjects(), threads: this.store.listThreads() };
      case "thread.create":
        return this.createThread(payload);
      case "thread.snapshot":
        return this.snapshot(payload);
      case "turn.send":
        return await this.sendTurn(payload);
      case "turn.interrupt":
        return await this.interrupt(payload);
      case "provider.detect":
        return await this.detect();
      default:
        throw new CommandError("unknown_command", `unknown command: ${cmd}`);
    }
  }

  /** Appends and broadcasts in one step so clients never see a gap. */
  private commit(events: NewEvent[]): DomainEvent[] {
    const stored = this.store.append(events);
    this.bus.events(stored);
    return stored;
  }

  private createProject(p: CommandPayloads["project.create"]): CommandResults["project.create"] {
    if (!p.rootPath || !existsSync(p.rootPath)) {
      throw new CommandError("invalid_payload", `path does not exist: ${p.rootPath}`);
    }
    const projectId = newId("prj");
    this.commit([
      { type: "project.created", threadId: null, payload: { projectId, name: p.name, rootPath: p.rootPath } },
    ]);
    const project = this.store.getProject(projectId);
    if (!project) throw new CommandError("internal", "project projection missing after append");
    return { project };
  }

  private createThread(p: CommandPayloads["thread.create"]): CommandResults["thread.create"] {
    if (!this.store.getProject(p.projectId)) {
      throw new CommandError("not_found", `no such project: ${p.projectId}`);
    }
    if (!this.registry.get(p.provider)) {
      throw new CommandError("provider_unavailable", `no adapter for provider: ${p.provider}`);
    }
    const threadId = newId("thr");
    this.commit([
      {
        type: "thread.created",
        threadId,
        payload: { threadId, projectId: p.projectId, title: p.title, provider: p.provider },
      },
    ]);
    const thread = this.store.getThread(threadId);
    if (!thread) throw new CommandError("internal", "thread projection missing after append");
    return { thread };
  }

  private snapshot(p: CommandPayloads["thread.snapshot"]): CommandResults["thread.snapshot"] {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    return { thread, messages: this.store.listMessages(p.threadId), seq: this.store.head() };
  }

  private async detect(): Promise<CommandResults["provider.detect"]> {
    const providers = await Promise.all(
      this.registry.list().map(async (a) => {
        const d = await a.detect();
        return {
          kind: a.kind,
          label: a.label,
          tier: a.tier,
          available: d.available,
          version: d.version,
          detail: d.detail,
          capabilities: { ...a.capabilities } as Record<string, boolean>,
        };
      }),
    );
    return { providers };
  }

  private async ensureSession(threadId: string): Promise<LiveSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;

    const thread = this.store.getThread(threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${threadId}`);
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new CommandError("not_found", `no such project: ${thread.projectId}`);

    const adapter = this.registry.get(thread.provider);
    if (!adapter) throw new CommandError("provider_unavailable", `no adapter: ${thread.provider}`);

    const detected = await adapter.detect();
    if (!detected.available) {
      throw new CommandError("provider_unavailable", detected.detail ?? `${thread.provider} unavailable`);
    }

    this.commit([{ type: "session.status", threadId, payload: { threadId, status: "connecting" } }]);

    const handle = await adapter.startSession({ threadId, cwd: project.rootPath }, (event) =>
      this.onRuntimeEvent(threadId, event),
    );

    const live: LiveSession = { handle, provider: thread.provider, activeTurnId: null };
    this.sessions.set(threadId, live);
    return live;
  }

  private async sendTurn(p: CommandPayloads["turn.send"]): Promise<CommandResults["turn.send"]> {
    const text = p.text.trim();
    if (!text) throw new CommandError("invalid_payload", "empty message");

    const session = await this.ensureSession(p.threadId);
    if (session.activeTurnId) {
      throw new CommandError("session_busy", "a turn is already running on this thread");
    }

    const turnId = newId("trn");
    session.activeTurnId = turnId;

    const thread = this.store.getThread(p.threadId);
    this.commit([
      { type: "turn.started", threadId: p.threadId, payload: { threadId: p.threadId, turnId, provider: thread?.provider ?? "" } },
      { type: "turn.message", threadId: p.threadId, payload: { threadId: p.threadId, turnId, role: "user", text } },
    ]);

    const adapter = this.registry.get(session.provider);
    try {
      await adapter!.sendTurn(session.handle, { turnId, text });
    } catch (err) {
      session.activeTurnId = null;
      this.commit([
        {
          type: "turn.failed",
          threadId: p.threadId,
          payload: { threadId: p.threadId, turnId, code: "send_failed", message: String(err) },
        },
        { type: "session.status", threadId: p.threadId, payload: { threadId: p.threadId, status: "error", detail: String(err) } },
      ]);
      throw new CommandError("internal", String(err));
    }

    return { turnId };
  }

  private async interrupt(p: CommandPayloads["turn.interrupt"]): Promise<CommandResults["turn.interrupt"]> {
    const session = this.sessions.get(p.threadId);
    if (!session) throw new CommandError("not_found", `no live session for thread ${p.threadId}`);

    // Explicit turnId: with two clients attached, "the current turn" is ambiguous.
    if (session.activeTurnId !== p.turnId) {
      throw new CommandError("not_found", `turn ${p.turnId} is not running`);
    }

    const adapter = this.registry.get(session.provider);
    await adapter!.interruptTurn(session.handle, p.turnId);
    session.activeTurnId = null;
    this.commit([
      { type: "turn.interrupted", threadId: p.threadId, payload: { threadId: p.threadId, turnId: p.turnId } },
    ]);
    return {};
  }

  /** Adapter events → domain events. Deltas bypass the log by design. */
  private onRuntimeEvent(threadId: string, event: ProviderRuntimeEvent) {
    const session = this.sessions.get(threadId);

    switch (event.type) {
      case "assistant.delta":
        // Ephemeral render hint. Never persisted — one row per token would be
        // an fsync storm, and the durable record is the committed message.
        this.bus.delta(threadId, event.turnId, event.text);
        return;

      case "assistant.message":
        this.commit([
          {
            type: "turn.message",
            threadId,
            payload: { threadId, turnId: event.turnId, role: "assistant", text: event.text },
          },
        ]);
        return;

      case "tool.started":
        this.commit([
          {
            type: "tool.started",
            threadId,
            payload: {
              threadId,
              turnId: event.turnId,
              toolCallId: event.toolCallId,
              name: event.name,
              ...(event.input !== undefined ? { input: event.input } : {}),
            },
          },
        ]);
        return;

      case "tool.finished":
        this.commit([
          {
            type: "tool.finished",
            threadId,
            payload: {
              threadId,
              turnId: event.turnId,
              toolCallId: event.toolCallId,
              ok: event.ok,
              ...(event.output !== undefined ? { output: event.output } : {}),
            },
          },
        ]);
        return;

      case "turn.completed":
        if (session?.activeTurnId === event.turnId) session.activeTurnId = null;
        this.commit([
          { type: "turn.completed", threadId, payload: { threadId, turnId: event.turnId } },
        ]);
        return;

      case "status":
        this.commit([
          {
            type: "session.status",
            threadId,
            payload: { threadId, status: event.status, ...(event.detail ? { detail: event.detail } : {}) },
          },
        ]);
        return;

      case "session.exited":
        this.sessions.delete(threadId);
        this.commit([
          { type: "session.status", threadId, payload: { threadId, status: "closed" } },
        ]);
        return;

      case "error": {
        const turnId = session?.activeTurnId;
        if (session) session.activeTurnId = null;
        const events: NewEvent[] = [];
        if (turnId) {
          events.push({
            type: "turn.failed",
            threadId,
            payload: { threadId, turnId, code: event.code, message: event.message },
          });
        }
        events.push({
          type: "session.status",
          threadId,
          payload: { threadId, status: "error", detail: event.message },
        });
        this.commit(events);
        return;
      }

      default:
        log.warn("unhandled runtime event", { threadId, event: JSON.stringify(event).slice(0, 200) });
    }
  }

  async shutdown() {
    for (const [threadId, session] of this.sessions) {
      const adapter = this.registry.get(session.provider);
      try {
        await adapter?.stopSession(session.handle);
      } catch (err) {
        log.warn("failed to stop session", { threadId, err: String(err) });
      }
    }
    this.sessions.clear();
  }
}
