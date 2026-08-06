import {
  CommandError,
  type CommandName,
  type CommandPayloads,
  type CommandResults,
  type DomainEvent,
  type NewEvent,
  type PermissionMode,
  type ProviderRuntimeEvent,
  type SessionHandle,
} from "@divisio/contracts";
import type { AdapterRegistry } from "@divisio/adapters";
import { newId } from "@divisio/shared/ids";
import { logger } from "@divisio/shared/log";
import { existsSync } from "node:fs";
import { captureCheckpoint, checkpointRef, diffCheckpoints } from "./checkpoint/store.ts";
import type { EventStore } from "./store/log.ts";
import { seedPrompt, summaryPrompt, type PacketContext } from "./handoff.ts";
import {
  allocateBranch,
  allocatePort,
  commitAll,
  compareUrl,
  copyCarryOver,
  createPrWithGh,
  createWorktree,
  defaultBaseBranch,
  diffLane,
  getRemote,
  hasGh,
  headSha,
  pushBranch,
  isDirty,
  isGitRepo,
  laneRoot,
  loadLaneConfig,
  pruneWorktrees,
  removeWorktree,
  runSetup,
} from "./lane/worktree.ts";

/**
 * Ceiling on concurrently active lanes. Each lane runs its own provider
 * process and its own MCP servers, so this bounds real machine load, not
 * bookkeeping. See docs/specs/worktrees.md.
 */
const MAX_ACTIVE_LANES = 4;

const log = logger("orchestrator");

export interface Broadcaster {
  events(events: DomainEvent[]): void;
  delta(threadId: string, turnId: string, text: string): void;
}

interface LiveSession {
  handle: SessionHandle;
  provider: string;
  activeTurnId: string | null;
  /** Pending approvals for the active turn (approvalId → meta). */
  pendingApprovals: Map<string, { turnId: string }>;
}

/**
 * Turns client commands into events and drives adapters.
 *
 * Plain modules, no decider/projector/reactor ceremony (ADR 0004). The
 * append-only log is what is load-bearing; the framework around it was not.
 */
export class Orchestrator {
  private readonly sessions = new Map<string, LiveSession>();
  /** Resolvers for turns awaited internally, e.g. the handoff summary. */
  private readonly turnWaiters = new Map<string, { resolve(): void; reject(err: Error): void }>();

  constructor(
    private readonly store: EventStore,
    private readonly registry: AdapterRegistry,
    private readonly bus: Broadcaster,
  ) {}

  async dispatch<C extends CommandName>(cmd: C, payload: CommandPayloads[C]): Promise<CommandResults[C]> {
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
      case "thread.setPermissionMode":
        return this.setPermissionMode(payload);
      case "turn.send":
        return await this.sendTurn(payload);
      case "turn.interrupt":
        return await this.interrupt(payload);
      case "turn.diff":
        return await this.turnDiff(payload);
      case "approval.respond":
        return await this.respondApproval(payload);
      case "provider.detect":
        return await this.detect();
      case "lane.create":
        return await this.createLane(payload);
      case "lane.list":
        return { lanes: this.store.listLanes((payload as { projectId?: string }).projectId) };
      case "lane.archive":
        return await this.archiveLane(payload);
      case "lane.diff":
        return await this.laneDiff(payload);
      case "lane.openPr":
        return await this.openPr(payload);
      case "thread.handoff":
        return await this.handoff(payload);
      default:
        throw new CommandError("unknown_command", `unknown command: ${cmd}`);
    }
  }

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
    if (p.laneId) {
      const lane = this.store.getLane(p.laneId);
      if (!lane) throw new CommandError("not_found", `no such lane: ${p.laneId}`);
      if (lane.projectId !== p.projectId) {
        throw new CommandError("invalid_payload", "lane belongs to a different project");
      }
      if (lane.status !== "ready") {
        throw new CommandError("session_busy", `lane is ${lane.status}, not ready`);
      }
      const adapter = this.registry.get(p.provider);
      // A lane means the provider runs with cwd set to a worktree. An adapter
      // that has not declared it can handle that must not be started there.
      if (adapter && !adapter.capabilities.worktreeAware) {
        throw new CommandError("provider_unavailable", `${p.provider} does not support worktrees`);
      }
    }

    const threadId = newId("thr");
    this.commit([
      {
        type: "thread.created",
        threadId,
        payload: {
          threadId,
          projectId: p.projectId,
          title: p.title,
          provider: p.provider,
          ...(p.laneId ? { laneId: p.laneId } : {}),
        },
      },
    ]);
    const thread = this.store.getThread(threadId);
    if (!thread) throw new CommandError("internal", "thread projection missing after append");
    return { thread };
  }

  private setPermissionMode(
    p: CommandPayloads["thread.setPermissionMode"],
  ): CommandResults["thread.setPermissionMode"] {
    if (!this.store.getThread(p.threadId)) {
      throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    }
    if (p.mode !== "supervised" && p.mode !== "full_access") {
      throw new CommandError("invalid_payload", `invalid permission mode: ${p.mode}`);
    }
    this.commit([
      {
        type: "thread.permission_mode_set",
        threadId: p.threadId,
        payload: { threadId: p.threadId, mode: p.mode },
      },
    ]);
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("internal", "thread projection missing after mode set");
    return { thread };
  }

  private snapshot(p: CommandPayloads["thread.snapshot"]): CommandResults["thread.snapshot"] {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    return { thread, messages: this.store.listMessages(p.threadId), seq: this.store.head() };
  }

  /* --------------------------------- lanes -------------------------------- */

  /**
   * Resolves the working directory for a thread: its lane root when bound to a
   * lane, otherwise the project's primary checkout.
   */
  private workdirFor(thread: { projectId: string; laneId: string | null }): string {
    if (thread.laneId) {
      const lane = this.store.getLane(thread.laneId);
      if (lane && lane.status !== "archived") return lane.root;
    }
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new CommandError("not_found", `no such project: ${thread.projectId}`);
    return project.rootPath;
  }

  private async createLane(p: CommandPayloads["lane.create"]): Promise<CommandResults["lane.create"]> {
    const project = this.store.getProject(p.projectId);
    if (!project) throw new CommandError("not_found", `no such project: ${p.projectId}`);

    if (!(await isGitRepo(project.rootPath))) {
      throw new CommandError(
        "invalid_payload",
        "parallel lanes need a git repository — this project is a plain directory",
      );
    }

    const active = this.store.listLanes(p.projectId).filter((l) => l.status !== "archived");
    if (active.length >= MAX_ACTIVE_LANES) {
      throw new CommandError(
        "session_busy",
        `lane limit reached (${MAX_ACTIVE_LANES}); archive a lane before starting another`,
      );
    }

    // Reconcile worktrees deleted outside the app before adding another.
    await pruneWorktrees(project.rootPath);

    const base = p.base ?? (await headSha(project.rootPath));
    if (!base) {
      throw new CommandError("invalid_payload", "repository has no commits to branch from");
    }

    const laneId = newId("lane");
    const branch = await allocateBranch(project.rootPath, p.title);
    const port = allocatePort(this.store.activeLanePorts());

    let created;
    try {
      created = await createWorktree(project.rootPath, p.projectId, laneId, branch, base);
    } catch (err) {
      throw new CommandError("internal", String(err instanceof Error ? err.message : err));
    }

    this.commit([
      {
        type: "lane.created",
        threadId: null,
        payload: {
          laneId,
          projectId: p.projectId,
          title: p.title,
          branch: created.branch,
          baseSha: created.baseSha,
          root: created.root,
          port,
        },
      },
    ]);

    // Carry-over and setup run in the background: a fresh worktree has no
    // dependencies, and blocking the command until `bun install` finishes
    // would look like the UI had hung.
    void this.prepareLane(laneId, project.rootPath, created.root, port);

    const lane = this.store.getLane(laneId);
    if (!lane) throw new CommandError("internal", "lane projection missing after append");
    return { lane };
  }

  private async prepareLane(laneId: string, projectRoot: string, root: string, port: number) {
    try {
      const config = await loadLaneConfig(projectRoot);
      const carried = await copyCarryOver(projectRoot, root, config.carryOver);
      log.info("lane carry-over", { laneId, copied: carried.copied.length, skipped: carried.skipped.length });

      if (config.setup) {
        const result = await runSetup(root, config.setup, port, config.portEnv);
        if (!result.ok) {
          this.commit([
            {
              type: "lane.status",
              threadId: null,
              payload: {
                laneId,
                status: "error",
                detail: `setup failed: ${result.output.trim().split("\n").slice(-3).join(" ")}`,
              },
            },
          ]);
          return;
        }
      }

      this.commit([
        { type: "lane.status", threadId: null, payload: { laneId, status: "ready" } },
      ]);
    } catch (err) {
      this.commit([
        {
          type: "lane.status",
          threadId: null,
          payload: { laneId, status: "error", detail: String(err) },
        },
      ]);
    }
  }

  private async archiveLane(p: CommandPayloads["lane.archive"]): Promise<CommandResults["lane.archive"]> {
    const lane = this.store.getLane(p.laneId);
    if (!lane) throw new CommandError("not_found", `no such lane: ${p.laneId}`);
    const project = this.store.getProject(lane.projectId);
    if (!project) throw new CommandError("not_found", "lane project missing");

    const dirty = await isDirty(lane.root).catch(() => false);
    if (dirty && !p.force) {
      // Refuse rather than silently discard. The caller must confirm knowing
      // there is uncommitted work.
      throw new CommandError(
        "invalid_payload",
        "lane has uncommitted changes; confirm to archive and discard them",
      );
    }

    // Snapshot before destroying, so the work survives the directory.
    if (dirty) {
      const capture = await captureCheckpoint(lane.root, p.laneId, "archive", "pre");
      log.info("captured lane before archive", { laneId: p.laneId, status: capture.status, ref: capture.ref });
    }

    // Stop any sessions still bound to this lane before the tree disappears.
    for (const thread of this.store.listThreads().filter((t) => t.laneId === p.laneId)) {
      const live = this.sessions.get(thread.id);
      if (!live) continue;
      await this.registry.get(live.provider)?.stopSession(live.handle).catch(() => undefined);
      this.sessions.delete(thread.id);
    }

    try {
      await removeWorktree(project.rootPath, lane.root, lane.branch, p.deleteBranch, p.force || dirty);
    } catch (err) {
      throw new CommandError("internal", String(err instanceof Error ? err.message : err));
    }

    this.commit([
      {
        type: "lane.archived",
        threadId: null,
        payload: { laneId: p.laneId, branchDeleted: p.deleteBranch, hadUncommittedChanges: dirty },
      },
    ]);

    const updated = this.store.getLane(p.laneId);
    if (!updated) throw new CommandError("internal", "lane projection missing after archive");
    return { lane: updated };
  }

  private async laneDiff(p: CommandPayloads["lane.diff"]): Promise<CommandResults["lane.diff"]> {
    const lane = this.store.getLane(p.laneId);
    if (!lane) throw new CommandError("not_found", `no such lane: ${p.laneId}`);
    if (lane.status === "archived") {
      return { files: [], patch: null, status: "skipped" };
    }
    const result = await diffLane(lane.root, lane.baseSha);
    return { files: result.files, patch: result.patch, status: result.status };
  }

  /**
   * Opens a pull request for a lane, degrading in stages: commit if asked,
   * push, then create the PR with `gh` when it is available and authenticated.
   * Each stage reports what happened rather than failing the whole flow, so a
   * user without `gh` still gets a working compare link.
   */
  private async openPr(p: CommandPayloads["lane.openPr"]): Promise<CommandResults["lane.openPr"]> {
    const lane = this.store.getLane(p.laneId);
    if (!lane) throw new CommandError("not_found", `no such lane: ${p.laneId}`);
    if (lane.status === "archived") {
      throw new CommandError("invalid_payload", "lane is archived");
    }

    const base = { branch: lane.branch, url: null, compareUrl: null };

    if (await isDirty(lane.root)) {
      if (!p.commitMessage?.trim()) {
        // A PR cannot come from an unrecorded tree, and committing on the
        // user's behalf without being asked is not ours to decide.
        return { ...base, status: "needs_commit", detail: "lane has uncommitted changes" };
      }
      const committed = await commitAll(lane.root, p.commitMessage.trim());
      if (!committed.ok) {
        return { ...base, status: "error", detail: committed.detail ?? "commit failed" };
      }
    }

    const remote = await getRemote(lane.root);
    if (!remote) {
      return { ...base, status: "error", detail: "no git remote configured for this repository" };
    }

    const pushed = await pushBranch(lane.root, remote.name, lane.branch);
    if (!pushed.ok) {
      return { ...base, status: "error", detail: pushed.detail ?? "push failed" };
    }

    const targetBranch = await defaultBaseBranch(lane.root, remote.name);
    const compare = remote.slug ? compareUrl(remote.slug, targetBranch, lane.branch) : null;

    // `gh` only understands GitHub remotes. Calling it on anything else fails
    // with a vendor error that tells the user nothing useful, so decide from
    // the remote we already parsed.
    if (!remote.slug) {
      return {
        ...base,
        status: "pushed",
        detail: `pushed to ${remote.name}; open the pull request in your git host`,
      };
    }

    if (!(await hasGh())) {
      return {
        ...base,
        status: "pushed",
        compareUrl: compare,
        detail: "gh not available — open the compare link to finish the pull request",
      };
    }

    const pr = await createPrWithGh(lane.root, targetBranch, p.title, p.body);
    if (!pr.ok) {
      return {
        ...base,
        status: "pushed",
        compareUrl: compare,
        detail: pr.detail ?? "gh pr create failed",
      };
    }

    return { ...base, status: "created", url: pr.url ?? null, compareUrl: compare, detail: null };
  }

  /* -------------------------------- handoff ------------------------------- */

  /** Waits for a turn to finish, so an internally-issued turn can be read back. */
  private awaitTurn(turnId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error("timed out waiting for the summary turn"));
      }, timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Moves a thread to another provider.
   *
   * The summary is produced by the source agent, because Divisio has no model
   * and does not proxy keys. That costs one turn on the source provider, which
   * the UI states rather than hides.
   */
  private async handoff(p: CommandPayloads["thread.handoff"]): Promise<CommandResults["thread.handoff"]> {
    const source = this.store.getThread(p.threadId);
    if (!source) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    if (source.provider === p.toProvider) {
      throw new CommandError("invalid_payload", "thread is already on that provider");
    }

    const target = this.registry.get(p.toProvider);
    if (!target) throw new CommandError("provider_unavailable", `no adapter: ${p.toProvider}`);
    const detected = await target.detect();
    if (!detected.available) {
      throw new CommandError("provider_unavailable", detected.detail ?? `${p.toProvider} unavailable`);
    }

    const live = this.sessions.get(p.threadId);
    if (live?.activeTurnId) {
      throw new CommandError("session_busy", "finish or interrupt the running turn before handing off");
    }

    // Ask the source agent to describe its own state.
    const { turnId } = await this.sendTurn({ threadId: p.threadId, text: summaryPrompt() });
    await this.awaitTurn(turnId, 180_000);

    const summary = this.store
      .listMessages(p.threadId)
      .find((m) => m.turnId === turnId && m.role === "assistant")?.text;
    if (!summary?.trim()) {
      throw new CommandError("internal", "the source agent produced no handover summary");
    }

    const context: PacketContext = {
      files: this.collectTouchedFiles(p.threadId),
      laneBranch: source.laneId ? (this.store.getLane(source.laneId)?.branch ?? null) : null,
    };

    // Continue in the same project and lane, so the working tree carries over.
    const { thread } = this.createThread({
      projectId: source.projectId,
      title: p.title?.trim() || `${source.title} (${target.label})`,
      provider: p.toProvider,
      ...(source.laneId ? { laneId: source.laneId } : {}),
    });

    this.commit([
      {
        type: "thread.handed_off",
        threadId: p.threadId,
        payload: {
          fromThreadId: p.threadId,
          toThreadId: thread.id,
          fromProvider: source.provider,
          toProvider: p.toProvider,
          summary,
        },
      },
    ]);

    // Seed the target as its first turn, so its own history explains itself.
    await this.sendTurn({ threadId: thread.id, text: seedPrompt(summary, source.provider, context) });

    const created = this.store.getThread(thread.id);
    if (!created) throw new CommandError("internal", "thread projection missing after handoff");
    return { thread: created, summary };
  }

  /** Files recorded by checkpoint diffs across the thread. Mechanical and free. */
  private collectTouchedFiles(threadId: string): string[] {
    const seen = new Set<string>();
    for (const diff of this.store.listTurnDiffs(threadId)) {
      for (const file of diff.files) seen.add(file.path);
    }
    return [...seen];
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

    // Lane-bound threads run inside their worktree; unbound threads run in the
    // primary checkout, which is the pre-lane behaviour.
    const handle = await adapter.startSession(
      { threadId, cwd: this.workdirFor(thread), permissionMode: thread.permissionMode },
      (event) => this.onRuntimeEvent(threadId, event),
    );

    const live: LiveSession = {
      handle,
      provider: thread.provider,
      activeTurnId: null,
      pendingApprovals: new Map(),
    };
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
    session.pendingApprovals.clear();

    const thread = this.store.getThread(p.threadId);
    const project = thread ? this.store.getProject(thread.projectId) : null;

    this.commit([
      {
        type: "turn.started",
        threadId: p.threadId,
        payload: { threadId: p.threadId, turnId, provider: thread?.provider ?? "" },
      },
      {
        type: "turn.message",
        threadId: p.threadId,
        payload: { threadId: p.threadId, turnId, role: "user", text },
      },
    ]);

    if (project && thread) {
      // Checkpoint the tree the agent will actually edit. Refs are shared
      // across worktrees, so a lane checkpoint is readable from anywhere.
      const pre = await captureCheckpoint(this.workdirFor(thread), p.threadId, turnId, "pre");
      this.commit([
        {
          type: "checkpoint.captured",
          threadId: p.threadId,
          payload: {
            threadId: p.threadId,
            turnId,
            phase: "pre",
            ref: pre.ref,
            sha: pre.sha,
            status: pre.status,
            ...(pre.detail ? { detail: pre.detail } : {}),
          },
        },
      ]);
    }

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
        {
          type: "session.status",
          threadId: p.threadId,
          payload: { threadId: p.threadId, status: "error", detail: String(err) },
        },
      ]);
      throw new CommandError("internal", String(err));
    }

    return { turnId };
  }

  private async interrupt(p: CommandPayloads["turn.interrupt"]): Promise<CommandResults["turn.interrupt"]> {
    const session = this.sessions.get(p.threadId);
    if (!session) throw new CommandError("not_found", `no live session for thread ${p.threadId}`);

    if (session.activeTurnId !== p.turnId) {
      throw new CommandError("not_found", `turn ${p.turnId} is not running`);
    }

    const adapter = this.registry.get(session.provider);
    await adapter!.interruptTurn(session.handle, p.turnId);
    session.activeTurnId = null;
    session.pendingApprovals.clear();
    this.commit([
      { type: "turn.interrupted", threadId: p.threadId, payload: { threadId: p.threadId, turnId: p.turnId } },
    ]);
    return {};
  }

  private async respondApproval(
    p: CommandPayloads["approval.respond"],
  ): Promise<CommandResults["approval.respond"]> {
    const session = this.sessions.get(p.threadId);
    if (!session) throw new CommandError("not_found", `no live session for thread ${p.threadId}`);
    if (!session.pendingApprovals.has(p.approvalId)) {
      throw new CommandError("not_found", `no pending approval: ${p.approvalId}`);
    }

    const adapter = this.registry.get(session.provider);
    if (!adapter?.respondToApproval) {
      throw new CommandError("provider_unavailable", "provider does not mediate approvals");
    }

    session.pendingApprovals.delete(p.approvalId);
    await adapter.respondToApproval(session.handle, p.approvalId, p.decision);
    this.commit([
      {
        type: "approval.resolved",
        threadId: p.threadId,
        payload: { threadId: p.threadId, approvalId: p.approvalId, decision: p.decision },
      },
    ]);
    return {};
  }

  private async turnDiff(p: CommandPayloads["turn.diff"]): Promise<CommandResults["turn.diff"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new CommandError("not_found", `no such project: ${thread.projectId}`);

    const stored = this.store.getTurnDiff(p.threadId, p.turnId);
    if (!stored) {
      return { turnId: p.turnId, files: [], patch: null, status: "missing", detail: "no diff for turn" };
    }

    const diff = await diffCheckpoints(this.workdirFor(thread), stored.fromRef, stored.toRef);
    return {
      turnId: p.turnId,
      files: diff.files,
      patch: diff.patch,
      status: diff.status,
      ...(diff.detail ? { detail: diff.detail } : {}),
    };
  }

  private permissionMode(threadId: string): PermissionMode {
    return this.store.getThread(threadId)?.permissionMode ?? "supervised";
  }

  private async finalizeCheckpoints(threadId: string, turnId: string) {
    const thread = this.store.getThread(threadId);
    const project = thread ? this.store.getProject(thread.projectId) : null;
    if (!project || !thread) return;

    const post = await captureCheckpoint(this.workdirFor(thread), threadId, turnId, "post");
    this.commit([
      {
        type: "checkpoint.captured",
        threadId,
        payload: {
          threadId,
          turnId,
          phase: "post",
          ref: post.ref,
          sha: post.sha,
          status: post.status,
          ...(post.detail ? { detail: post.detail } : {}),
        },
      },
    ]);

    if (post.status !== "ready") return;

    const fromRef = checkpointRef(threadId, turnId, "pre");
    const diff = await diffCheckpoints(this.workdirFor(thread), fromRef, post.ref);
    if (diff.status === "ready") {
      this.commit([
        {
          type: "turn.diff_ready",
          threadId,
          payload: {
            threadId,
            turnId,
            fromRef,
            toRef: post.ref,
            files: diff.files,
          },
        },
      ]);
    }
  }

  private onRuntimeEvent(threadId: string, event: ProviderRuntimeEvent) {
    const session = this.sessions.get(threadId);

    switch (event.type) {
      case "assistant.delta":
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

      case "approval.requested": {
        const category = (
          ["fs.write", "fs.read", "shell.exec", "network", "other"] as const
        ).includes(event.category as never)
          ? (event.category as "fs.write" | "fs.read" | "shell.exec" | "network" | "other")
          : "other";

        const mode = this.permissionMode(threadId);
        const adapter = session ? this.registry.get(session.provider) : null;

        // Full access + mediating adapter → auto-approve without UI prompt.
        if (mode === "full_access" && adapter?.respondToApproval && session) {
          this.commit([
            {
              type: "approval.requested",
              threadId,
              payload: {
                threadId,
                turnId: event.turnId,
                approvalId: event.approvalId,
                category,
                summary: event.summary,
              },
            },
            {
              type: "approval.resolved",
              threadId,
              payload: {
                threadId,
                approvalId: event.approvalId,
                decision: "approve",
              },
            },
          ]);
          void adapter.respondToApproval(session.handle, event.approvalId, "approve").catch((err) => {
            log.warn("auto-approve failed", { threadId, err: String(err) });
          });
          return;
        }

        session?.pendingApprovals.set(event.approvalId, { turnId: event.turnId });
        this.commit([
          {
            type: "approval.requested",
            threadId,
            payload: {
              threadId,
              turnId: event.turnId,
              approvalId: event.approvalId,
              category,
              summary: event.summary,
            },
          },
        ]);
        return;
      }

      case "turn.completed":
        if (session?.activeTurnId === event.turnId) session.activeTurnId = null;
        session?.pendingApprovals.clear();
        this.commit([{ type: "turn.completed", threadId, payload: { threadId, turnId: event.turnId } }]);
        this.turnWaiters.get(event.turnId)?.resolve();
        this.turnWaiters.delete(event.turnId);
        void this.finalizeCheckpoints(threadId, event.turnId).catch((err) => {
          log.warn("checkpoint finalize failed", { threadId, turnId: event.turnId, err: String(err) });
        });
        return;

      case "status":
        this.commit([
          {
            type: "session.status",
            threadId,
            payload: {
              threadId,
              status: event.status,
              ...(event.detail ? { detail: event.detail } : {}),
            },
          },
        ]);
        return;

      case "session.exited":
        this.sessions.delete(threadId);
        this.commit([{ type: "session.status", threadId, payload: { threadId, status: "closed" } }]);
        return;

      case "error": {
        const turnId = session?.activeTurnId;
        if (session) {
          session.activeTurnId = null;
          session.pendingApprovals.clear();
        }
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
        if (turnId) {
          this.turnWaiters.get(turnId)?.reject(new Error(event.message));
          this.turnWaiters.delete(turnId);
        }
        return;
      }

      default:
        log.warn("unhandled runtime event", {
          threadId,
          event: JSON.stringify(event).slice(0, 200),
        });
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
