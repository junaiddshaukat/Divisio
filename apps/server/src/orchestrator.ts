import {
  CommandError,
  type CommandName,
  type CommandPayloads,
  type CommandResults,
  type DiffFileEntry,
  type DomainEvent,
  type ModelCatalog,
  type NewEvent,
  type PermissionMode,
  type ProviderRuntimeEvent,
  type SessionHandle,
  type VendorResumeOutcome,
  type SessionStatus,
} from "@divisio/contracts";
import type { AdapterRegistry } from "@divisio/adapters";
import { EMPTY_MODEL_CATALOG } from "@divisio/adapters";
import { newId } from "@divisio/shared/ids";
import { logger } from "@divisio/shared/log";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { captureCheckpoint, checkpointRef, diffCheckpoints, restoreCheckpoint } from "./checkpoint/store.ts";
import type { EventStore } from "./store/log.ts";
import { seedPrompt, summaryPrompt, formatHandoffTranscript, logPacketPrompt, LOG_PACKET_SUMMARY, type PacketContext } from "./handoff.ts";
import { validateModel, validateNativeId } from "./models.ts";
import {
  deleteCustomProvider as deleteCustomProviderRecord,
  listCustomProviders as listCustomProviderViews,
  upsertCustomProvider as upsertCustomProviderRecord,
} from "./customProviders.ts";
import { syncCustomAdapters } from "./syncCustomAdapters.ts";
import {
  FileTooLargeError,
  PathEscapeError,
  listDirectory,
  readTextFile,
  writeTextFile,
} from "./files/service.ts";
import type { PairingStatus } from "@divisio/contracts";
import { probeToolchain } from "./toolchain.ts";
import { collectUsageStats } from "./usage/collectUsage.ts";
import { setupFor } from "@divisio/adapters/setup";

/** What the orchestrator needs from pairing, so it does not depend on transport. */
export interface PairingControls {
  status(): PairingStatus;
  createToken(): { url: string; expiresAt: string; fingerprint: string | null };
  revoke(clientId: string): boolean;
  revokeAll(): number;
}

/** Loopback-only daemons report pairing as unavailable rather than half-working. */
const disabledPairing: PairingControls = {
  status: () => ({ remote: false, tls: false, address: null, fingerprint: null, clients: [] }),
  createToken() {
    throw new CommandError("invalid_payload", "remote access is off; start the daemon with DIVISIO_BIND set");
  },
  revoke: () => false,
  revokeAll: () => 0,
};
import {
  allocateBranch,
  allocatePort,
  commitAll,
  compareUrl,
  copyCarryOver,
  createPrWithGh,
  createWorktree,
  currentBranch,
  defaultBaseBranch,
  diffLane,
  diffWorkingTree,
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
  /** Last native id written to the log for this live session. */
  persistedNativeId: string | null;
  /** Streamed assistant text not yet committed as `turn.message`. */
  partialByTurn: Map<string, string>;
  /** Turns that already have an assistant `turn.message`. */
  committedAssistant: Set<string>;
  /** Stop was requested for this turn; CLI `is_error` after SIGTERM is not a failure. */
  stoppingTurnId: string | null;
}

/**
 * Turns client commands into events and drives adapters.
 *
 * Plain modules, no decider/projector/reactor ceremony (ADR 0004). The
 * append-only log is what is load-bearing; the framework around it was not.
 */
/** Commands the orchestrator routes. Kept beside the switch that handles them. */
export const ORCHESTRATOR_COMMANDS = [
  "project.create", "project.list", "project.clone", "project.remove",
  "thread.create", "thread.rename", "thread.delete", "thread.snapshot", "thread.setPermissionMode", "thread.setProvider", "thread.handoff",
  "thread.commit", "thread.diff", "thread.gitStatus", "thread.push",
  "turn.send", "turn.interrupt", "turn.diff", "turn.restore",
  "approval.respond", "provider.detect", "provider.models", "customProvider.list", "customProvider.upsert", "customProvider.delete",
  "toolchain.status", "stats.activity", "stats.usage",
  "lane.create", "lane.list", "lane.archive", "lane.diff", "lane.openPr",
  "file.tree", "file.read", "file.write",
  "pairing.status", "pairing.createToken", "pairing.revoke", "pairing.revokeAll",
] as const;

export class Orchestrator {
  private readonly sessions = new Map<string, LiveSession>();
  /** Resolvers for turns awaited internally, e.g. the handoff summary. */
  private readonly turnWaiters = new Map<string, { resolve(): void; reject(err: Error): void }>();

  constructor(
    private readonly store: EventStore,
    private readonly registry: AdapterRegistry,
    private readonly bus: Broadcaster,
    /** Remote pairing. A loopback-only daemon gets a stub that reports disabled. */
    private readonly pairing: PairingControls = disabledPairing,
  ) {}

  async dispatch<C extends CommandName>(cmd: C, payload: CommandPayloads[C]): Promise<CommandResults[C]> {
    return (await this.route(cmd, payload as never)) as CommandResults[C];
  }

  private async route(cmd: CommandName, payload: never): Promise<unknown> {
    switch (cmd) {
      case "project.create":
        return this.createProject(payload);
      case "project.clone":
        return await this.cloneProject(payload);
      case "project.remove":
        return await this.removeProject(payload);
      case "project.list":
        return { projects: this.store.listProjects(), threads: this.store.listThreads() };
      case "thread.create":
        return this.createThread(payload);
      case "thread.rename":
        return this.renameThread(payload);
      case "thread.delete":
        return await this.deleteThread(payload);
      case "thread.snapshot":
        return this.snapshot(payload);
      case "thread.setPermissionMode":
        return this.setPermissionMode(payload);
      case "thread.setProvider":
        return await this.setProvider(payload);
      case "turn.send":
        return await this.sendTurn(payload);
      case "turn.interrupt":
        return await this.interrupt(payload);
      case "turn.diff":
        return await this.turnDiff(payload);
      case "turn.restore":
        return await this.restoreTurn(payload);
      case "thread.commit":
        return await this.commitThread(payload);
      case "thread.diff":
        return await this.threadDiff(payload);
      case "thread.gitStatus":
        return await this.threadGitStatus(payload);
      case "thread.push":
        return await this.pushThread(payload);
      case "approval.respond":
        return await this.respondApproval(payload);
      case "provider.detect":
        return await this.detect();
      case "provider.models":
        return await this.listModels(payload);
      case "customProvider.list":
        return this.listCustomProviders();
      case "customProvider.upsert":
        return this.upsertCustomProvider(payload);
      case "customProvider.delete":
        return this.deleteCustomProvider(payload);
      case "toolchain.status":
        return await probeToolchain();
      case "stats.activity":
        return this.store.activityStats();
      case "stats.usage":
        return await collectUsageStats(this.store, (payload as { days?: unknown }).days);
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
      case "file.tree":
        return await this.fileTree(payload);
      case "file.read":
        return await this.fileRead(payload);
      case "file.write":
        return await this.fileWrite(payload);
      case "pairing.status":
        return this.pairing.status();
      case "pairing.createToken":
        return this.pairing.createToken();
      case "pairing.revoke":
        return { revoked: this.pairing.revoke((payload as { clientId: string }).clientId) };
      case "pairing.revokeAll":
        return { revoked: this.pairing.revokeAll() };
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

  private async cloneProject(p: CommandPayloads["project.clone"]): Promise<CommandResults["project.clone"]> {
    const url = p.url.trim();
    const parent = p.parentPath.trim();
    if (!url) throw new CommandError("invalid_payload", "clone URL is required");
    if (!parent || !existsSync(parent)) {
      throw new CommandError("invalid_payload", `parent path does not exist: ${parent}`);
    }

    const folder =
      p.name?.trim() ||
      basename(url.replace(/\/$/, "").replace(/\.git$/i, "")) ||
      "repo";
    if (folder.includes("/") || folder.includes("\\") || folder === "." || folder === "..") {
      throw new CommandError("invalid_payload", "invalid destination folder name");
    }
    const rootPath = join(parent, folder);
    if (existsSync(rootPath)) {
      throw new CommandError("invalid_payload", `destination already exists: ${rootPath}`);
    }

    const proc = Bun.spawn(["git", "clone", "--", url, rootPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const detail = (stderr || stdout).trim().split("\n").slice(-4).join(" ");
      throw new CommandError("internal", detail || `git clone failed (exit ${code})`);
    }

    return this.createProject({ name: folder, rootPath });
  }

  /**
   * Soft-remove a project from Divisio. Never deletes the folder on disk or
   * lane worktrees — only hides the project and its chats in the product.
   */
  private async removeProject(p: CommandPayloads["project.remove"]): Promise<CommandResults["project.remove"]> {
    const project = this.store.getProject(p.projectId);
    if (!project) throw new CommandError("not_found", `no such project: ${p.projectId}`);

    const threads = this.store.listThreads().filter((t) => t.projectId === p.projectId);
    for (const thread of threads) {
      const live = this.sessions.get(thread.id);
      if (live?.activeTurnId) {
        throw new CommandError(
          "session_busy",
          "Stop running turns in this project before removing it from Divisio.",
        );
      }
    }
    for (const thread of threads) {
      const live = this.sessions.get(thread.id);
      if (live) {
        this.persistVendorSession(thread.id);
        const adapter = this.registry.get(live.provider);
        await adapter?.stopSession(live.handle).catch(() => undefined);
        this.sessions.delete(thread.id);
      }
    }

    this.commit([
      {
        type: "project.removed",
        threadId: null,
        payload: { projectId: p.projectId },
      },
    ]);
    return {};
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

  private renameThread(p: CommandPayloads["thread.rename"]): CommandResults["thread.rename"] {
    if (!this.store.getThread(p.threadId)) {
      throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    }
    const title = p.title.trim();
    if (!title) throw new CommandError("invalid_payload", "title cannot be empty");
    if (title.length > 120) throw new CommandError("invalid_payload", "title is too long");
    this.commit([
      {
        type: "thread.renamed",
        threadId: p.threadId,
        payload: { threadId: p.threadId, title },
      },
    ]);
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("internal", "thread projection missing after rename");
    return { thread };
  }

  private async deleteThread(p: CommandPayloads["thread.delete"]): Promise<CommandResults["thread.delete"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);

    const live = this.sessions.get(p.threadId);
    if (live?.activeTurnId) {
      throw new CommandError("session_busy", "Stop the running turn before deleting this chat.");
    }
    if (live) {
      this.persistVendorSession(p.threadId);
      const adapter = this.registry.get(live.provider);
      await adapter?.stopSession(live.handle).catch(() => undefined);
      this.sessions.delete(p.threadId);
    }

    this.commit([
      {
        type: "thread.deleted",
        threadId: p.threadId,
        payload: { threadId: p.threadId },
      },
    ]);
    return {};
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

  /**
   * Empty-thread provider/model switch. History requires `thread.handoff` for
   * provider changes so context is summarized by the source agent.
   */
  private async setProvider(
    p: CommandPayloads["thread.setProvider"],
  ): Promise<CommandResults["thread.setProvider"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    if (!this.registry.get(p.provider)) {
      throw new CommandError("provider_unavailable", `no adapter for provider: ${p.provider}`);
    }

    const providerChanging = p.provider !== thread.provider;
    const messages = this.store.listMessages(p.threadId);
    if (providerChanging && messages.length > 0) {
      throw new CommandError(
        "invalid_payload",
        "thread has history — use Hand off to change provider (costs one turn on the current agent)",
      );
    }

    const live = this.sessions.get(p.threadId);
    if (live?.activeTurnId) {
      throw new CommandError("session_busy", "cannot change provider while a turn is running");
    }
    if (live && providerChanging) {
      this.persistVendorSession(p.threadId);
      const adapter = this.registry.get(live.provider);
      try {
        await adapter?.stopSession(live.handle);
      } catch {
        /* best-effort teardown */
      }
      this.sessions.delete(p.threadId);
    }

    // Validated here rather than at the adapter: every adapter would otherwise
    // have to repeat it, and a community adapter would be trusted to remember.
    const model = p.model === undefined ? thread.model : validateModel(p.model);

    this.commit([
      {
        type: "thread.provider_set",
        threadId: p.threadId,
        payload: { threadId: p.threadId, provider: p.provider, model },
      },
    ]);
    const updated = this.store.getThread(p.threadId);
    if (!updated) throw new CommandError("internal", "thread projection missing after provider set");
    return { thread: updated };
  }

  private snapshot(p: CommandPayloads["thread.snapshot"]): CommandResults["thread.snapshot"] {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    return {
      thread,
      messages: this.store.listMessages(p.threadId),
      seq: this.store.head(),
      activeTurnId: this.sessions.get(p.threadId)?.activeTurnId ?? null,
      diffs: this.store.listTurnDiffs(p.threadId).map((d) => ({
        turnId: d.turnId,
        files: d.files as DiffFileEntry[],
      })),
    };
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
      this.persistVendorSession(thread.id);
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

  /**
   * Restores the tree to a turn's checkpoint.
   *
   * Refused while a turn is running: the agent has the working tree open, and
   * changing files underneath it produces a state neither side understands.
   */
  private async restoreTurn(p: CommandPayloads["turn.restore"]): Promise<CommandResults["turn.restore"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);

    if (this.sessions.get(p.threadId)?.activeTurnId) {
      throw new CommandError("session_busy", "stop the running turn before restoring");
    }

    const ref = checkpointRef(p.threadId, p.turnId, p.phase);
    const result = await restoreCheckpoint(this.workdirFor(thread), ref, p.threadId);

    if (result.status === "restored") {
      log.info("restored checkpoint", {
        threadId: p.threadId,
        turnId: p.turnId,
        phase: p.phase,
        files: result.files.length,
        undoRef: result.undoRef,
      });
    }

    return {
      status: result.status,
      files: result.files,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  /**
   * Stages and commits the thread's working tree. Message is required — we
   * never invent one. Used by the Changes pane Commit action.
   */
  private async commitThread(p: CommandPayloads["thread.commit"]): Promise<CommandResults["thread.commit"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    if (this.sessions.get(p.threadId)?.activeTurnId) {
      throw new CommandError("session_busy", "stop the running turn before committing");
    }
    const message = p.message.trim();
    if (!message) throw new CommandError("invalid_payload", "commit message is required");

    const root = this.workdirFor(thread);
    if (!(await isGitRepo(root))) {
      return { ok: false, detail: "working directory is not a git repository" };
    }
    if (!(await isDirty(root))) {
      return { ok: false, detail: "nothing to commit" };
    }
    return commitAll(root, message, p.paths);
  }

  private async threadGitStatus(
    p: CommandPayloads["thread.gitStatus"],
  ): Promise<CommandResults["thread.gitStatus"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    const root = this.workdirFor(thread);
    if (!(await isGitRepo(root))) {
      return { dirty: false, branch: null, laneId: thread.laneId, hasRemote: false, git: false };
    }
    const remote = await getRemote(root);
    return {
      dirty: await isDirty(root),
      branch: await currentBranch(root),
      laneId: thread.laneId,
      hasRemote: !!remote,
      git: true,
    };
  }

  private async threadDiff(p: CommandPayloads["thread.diff"]): Promise<CommandResults["thread.diff"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    const root = this.workdirFor(thread);
    const branch = (await isGitRepo(root)) ? await currentBranch(root) : null;

    if (p.scope === "working") {
      const result = await diffWorkingTree(root);
      return {
        scope: "working",
        files: result.files,
        patch: result.patch,
        status: result.status,
        branch,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    }

    // Branch scope: lane vs its base, otherwise vs the remote default branch.
    if (thread.laneId) {
      const lane = this.store.getLane(thread.laneId);
      if (!lane || lane.status === "archived") {
        return { scope: "branch", files: [], patch: null, status: "skipped", branch, detail: "lane unavailable" };
      }
      const result = await diffLane(lane.root, lane.baseSha);
      return {
        scope: "branch",
        files: result.files,
        patch: result.patch,
        status: result.status,
        branch: lane.branch,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    }

    if (!(await isGitRepo(root))) {
      return { scope: "branch", files: [], patch: null, status: "skipped", branch, detail: "not a git repository" };
    }
    const remote = await getRemote(root);
    if (!remote) {
      return { scope: "branch", files: [], patch: null, status: "skipped", branch, detail: "no git remote" };
    }
    const base = await defaultBaseBranch(root, remote.name);
    const result = await diffLane(root, `${remote.name}/${base}`);
    return {
      scope: "branch",
      files: result.files,
      patch: result.patch,
      status: result.status,
      branch,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  private async pushThread(p: CommandPayloads["thread.push"]): Promise<CommandResults["thread.push"]> {
    const thread = this.store.getThread(p.threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
    if (this.sessions.get(p.threadId)?.activeTurnId) {
      throw new CommandError("session_busy", "stop the running turn before pushing");
    }
    const root = this.workdirFor(thread);
    if (!(await isGitRepo(root))) {
      return { ok: false, detail: "working directory is not a git repository" };
    }
    if (await isDirty(root)) {
      return { ok: false, detail: "commit changes before pushing" };
    }
    const branch = await currentBranch(root);
    if (!branch) return { ok: false, detail: "detached HEAD — check out a branch to push" };
    const remote = await getRemote(root);
    if (!remote) return { ok: false, detail: "no git remote configured" };

    const pushed = await pushBranch(root, remote.name, branch);
    if (!pushed.ok) return { ok: false, detail: pushed.detail ?? "push failed" };

    const target = await defaultBaseBranch(root, remote.name);
    const compare = remote.slug ? compareUrl(remote.slug, target, branch) : null;
    return { ok: true, compareUrl: compare };
  }

  /* --------------------------------- files -------------------------------- */

  /**
   * Files resolve against the thread's working directory, so a lane-bound
   * thread browses its own worktree rather than the primary checkout.
   */
  /** Public because terminals resolve the same directory the agent works in. */
  workdirForThread(threadId: string): string {
    return this.rootForThread(threadId);
  }

  private rootForThread(threadId: string): string {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new CommandError("not_found", `no such thread: ${threadId}`);
    return this.workdirFor(thread);
  }

  /** Maps file errors onto command errors without leaking absolute paths. */
  private fileError(err: unknown): never {
    if (err instanceof PathEscapeError) {
      throw new CommandError("invalid_payload", "that path is outside the project");
    }
    if (err instanceof FileTooLargeError) {
      throw new CommandError("invalid_payload", err.message);
    }
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") throw new CommandError("not_found", "file not found");
    if (code === "EACCES") throw new CommandError("invalid_payload", "permission denied");
    throw new CommandError("internal", String(err));
  }

  private async fileTree(p: CommandPayloads["file.tree"]): Promise<CommandResults["file.tree"]> {
    const root = this.rootForThread(p.threadId);
    try {
      return { entries: await listDirectory(root, p.path ?? ""), path: p.path ?? "" };
    } catch (err) {
      this.fileError(err);
    }
  }

  private async fileRead(p: CommandPayloads["file.read"]): Promise<CommandResults["file.read"]> {
    const root = this.rootForThread(p.threadId);
    try {
      return await readTextFile(root, p.path);
    } catch (err) {
      this.fileError(err);
    }
  }

  private async fileWrite(p: CommandPayloads["file.write"]): Promise<CommandResults["file.write"]> {
    const root = this.rootForThread(p.threadId);
    try {
      await writeTextFile(root, p.path, p.content);
      return { path: p.path };
    } catch (err) {
      this.fileError(err);
    }
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
   * Like awaitTurn, but resolves immediately if the turn already finished
   * (race: completion between sendTurn returning and waiter registration).
   */
  private async waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<void> {
    if (this.sessions.get(threadId)?.activeTurnId !== turnId) return;
    const done = this.awaitTurn(turnId, timeoutMs);
    // Completion may have landed between the check and registering the waiter.
    if (this.sessions.get(threadId)?.activeTurnId !== turnId) {
      this.turnWaiters.get(turnId)?.resolve();
      this.turnWaiters.delete(turnId);
      return;
    }
    return done;
  }

  /**
   * Moves a thread to another provider.
   *
   * Prefers a handover note from the source agent when it can still take a
   * turn. If it cannot (usage limit, crash, or `packet: "log"`), Divisio
   * seeds the target from the event log — we already have the transcript.
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
      throw new CommandError(
        "session_busy",
        "Stop the running turn before handing off.",
      );
    }

    const history = this.store
      .listMessages(p.threadId)
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim());
    if (history.length === 0) {
      throw new CommandError(
        "invalid_payload",
        "Nothing to hand off yet — send at least one message in this chat first.",
      );
    }

    const transcript = formatHandoffTranscript(history);
    const context: PacketContext = {
      files: this.collectTouchedFiles(p.threadId),
      laneBranch: source.laneId ? (this.store.getLane(source.laneId)?.branch ?? null) : null,
    };

    const skipAgent = p.packet === "log" || source.status === "error";
    let agentNote: string | null = null;
    if (!skipAgent) {
      agentNote = await this.askSourceForHandoffNote(p.threadId, transcript);
    }

    const packet: "agent" | "log" = agentNote ? "agent" : "log";
    const summary = agentNote ?? LOG_PACKET_SUMMARY;
    const seed = agentNote
      ? seedPrompt(agentNote, source.provider, context)
      : logPacketPrompt(source.provider, transcript, context);

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
          packet,
        },
      },
    ]);

    await this.sendTurn({ threadId: thread.id, text: seed });

    const created = this.store.getThread(thread.id);
    if (!created) throw new CommandError("internal", "thread projection missing after handoff");
    return { thread: created, summary, packet };
  }

  /** Returns the source-agent note, or null if that turn failed or was empty. */
  private async askSourceForHandoffNote(threadId: string, transcript: string): Promise<string | null> {
    try {
      const { turnId } = await this.sendTurn({ threadId, text: summaryPrompt(transcript) });
      await this.waitForTurn(threadId, turnId, 180_000);
      const text = this.store
        .listMessages(threadId)
        .find((m) => m.turnId === turnId && m.role === "assistant")?.text;
      return text?.trim() ? text : null;
    } catch {
      return null;
    }
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
      this.registry.listEntries().map(async ({ adapter: a, source }) => {
        const d = await a.detect();
        return {
          kind: a.kind,
          label: a.label,
          tier: a.tier,
          source,
          available: d.available,
          version: d.version,
          detail: d.detail,
          // Setup commands come from a declared table rather than a probe:
          // asking a CLI about its auth can start a login flow (see
          // packages/adapters/src/shared/setup.ts).
          ...setupFor(a.kind),
          authenticated: d.authenticated ?? null,
          capabilities: { ...a.capabilities } as Record<string, boolean>,
          preferredModel:
            "preferredModel" in a && typeof (a as { preferredModel?: unknown }).preferredModel === "string"
              ? (a as { preferredModel: string }).preferredModel
              : null,
        };
      }),
    );
    return { providers };
  }

  private async listModels(
    payload: CommandPayloads["provider.models"],
  ): Promise<CommandResults["provider.models"]> {
    const entries = this.registry.listEntries().filter(
      ({ adapter }) => !payload.kind || adapter.kind === payload.kind,
    );
    const catalogs: Record<string, ModelCatalog> = {};
    await Promise.all(
      entries.map(async ({ adapter }) => {
        if (!adapter.listModels) {
          catalogs[adapter.kind] = EMPTY_MODEL_CATALOG;
          return;
        }
        try {
          catalogs[adapter.kind] = await adapter.listModels();
        } catch (err) {
          log.warn("listModels failed", {
            kind: adapter.kind,
            error: err instanceof Error ? err.message : String(err),
          });
          catalogs[adapter.kind] = EMPTY_MODEL_CATALOG;
        }
      }),
    );
    return { catalogs };
  }

  private listCustomProviders(): CommandResults["customProvider.list"] {
    return { providers: listCustomProviderViews() };
  }

  private upsertCustomProvider(
    p: CommandPayloads["customProvider.upsert"],
  ): CommandResults["customProvider.upsert"] {
    try {
      const provider = upsertCustomProviderRecord(p);
      syncCustomAdapters(this.registry);
      return { provider };
    } catch (err) {
      throw new CommandError("invalid_payload", err instanceof Error ? err.message : String(err));
    }
  }

  private deleteCustomProvider(
    p: CommandPayloads["customProvider.delete"],
  ): CommandResults["customProvider.delete"] {
    const deleted = deleteCustomProviderRecord(p.id);
    if (deleted) syncCustomAdapters(this.registry);
    return { deleted };
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
    const canResume = adapter.capabilities.sessionResume;
    const resumeId = canResume ? validateNativeId(thread.vendorSessionId) : null;
    let handle: SessionHandle;
    try {
      handle = await adapter.startSession(
        {
          threadId,
          cwd: this.workdirFor(thread),
          permissionMode: thread.permissionMode,
          ...(resumeId ? { resumeId } : {}),
        },
        (event) => this.onRuntimeEvent(threadId, event),
      );
    } catch (err) {
      if (resumeId) {
        this.commit([
          {
            type: "session.resume_outcome",
            threadId,
            payload: {
              threadId,
              outcome: "failed",
              nativeId: resumeId,
              detail: err instanceof Error ? err.message : String(err),
            },
          },
        ]);
      }
      this.commit([{ type: "session.status", threadId, payload: { threadId, status: "error" } }]);
      throw err;
    }

    const live: LiveSession = {
      handle,
      provider: thread.provider,
      activeTurnId: null,
      pendingApprovals: new Map(),
      persistedNativeId: resumeId,
      partialByTurn: new Map(),
      committedAssistant: new Set(),
      stoppingTurnId: null,
    };
    this.sessions.set(threadId, live);
    this.persistVendorSession(threadId);

    const outcome: VendorResumeOutcome = !canResume ? "unsupported" : resumeId ? "resumed" : "cold";
    this.commit([
      {
        type: "session.resume_outcome",
        threadId,
        payload: {
          threadId,
          outcome,
          ...(resumeId ? { nativeId: resumeId } : {}),
        },
      },
    ]);
    return live;
  }

  private async sendTurn(p: CommandPayloads["turn.send"]): Promise<CommandResults["turn.send"]> {
    const images = p.images ?? [];
    let text = p.text.trim();
    if (!text && images.length === 0) {
      throw new CommandError("invalid_payload", "empty message");
    }
    if (images.length > 8) {
      throw new CommandError("invalid_payload", "at most 8 images per turn");
    }

    // Validate before anything is mutated. Rejecting after `activeTurnId` was
    // set left the thread permanently busy with no turn behind it.
    const requestedModel = validateModel(p.model);

    const session = await this.ensureSession(p.threadId);
    if (session.activeTurnId) {
      throw new CommandError("session_busy", "a turn is already running on this thread");
    }

    const thread = this.store.getThread(p.threadId);
    const project = thread ? this.store.getProject(thread.projectId) : null;

    if (images.length > 0) {
      if (!thread) throw new CommandError("not_found", `no such thread: ${p.threadId}`);
      const root = this.workdirFor(thread);
      const saved = await writeTurnImages(root, images);
      const list = saved.map((rel) => `- ${rel}`).join("\n");
      const note = `Attached images (saved in the working tree):\n${list}`;
      text = text ? `${text}\n\n${note}` : note;
    }

    const turnId = newId("trn");
    session.activeTurnId = turnId;
    session.stoppingTurnId = null;
    session.pendingApprovals.clear();

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
    const model = (requestedModel ?? validateModel(thread?.model)) ?? undefined;
    try {
      await adapter!.sendTurn(session.handle, {
        turnId,
        text,
        ...(model ? { model } : {}),
      });
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

    // Mark stopping before the kill so a CLI `is_error` result is not a failure.
    session.stoppingTurnId = p.turnId;
    this.flushPartialAssistant(session, p.threadId, p.turnId);

    const adapter = this.registry.get(session.provider);
    await adapter!.interruptTurn(session.handle, p.turnId);
    session.activeTurnId = null;
    session.pendingApprovals.clear();
    this.commit([
      { type: "turn.interrupted", threadId: p.threadId, payload: { threadId: p.threadId, turnId: p.turnId } },
    ]);
    return {};
  }

  /** Persist streamed text so Stop does not throw away what the user already saw. */
  private flushPartialAssistant(session: LiveSession, threadId: string, turnId: string) {
    if (session.committedAssistant.has(turnId)) return;
    const text = session.partialByTurn.get(turnId);
    if (!text) return;
    session.committedAssistant.add(turnId);
    this.commit([
      {
        type: "turn.message",
        threadId,
        payload: { threadId, turnId, role: "assistant", text },
      },
    ]);
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

  /**
   * Writes `thread.vendor_session_set` when the live handle has a new native
   * id. No-op when the session is not yet in the map (startSession emit
   * before we insert) or when the id is unchanged / unusable as argv.
   */
  private persistVendorSession(threadId: string) {
    const session = this.sessions.get(threadId);
    if (!session) return;
    const nativeId = validateNativeId(session.handle.nativeId);
    if (!nativeId || nativeId === session.persistedNativeId) return;
    this.commit([
      {
        type: "thread.vendor_session_set",
        threadId,
        payload: { threadId, nativeId, provider: session.provider },
      },
    ]);
    session.persistedNativeId = nativeId;
  }

  private onRuntimeEvent(threadId: string, event: ProviderRuntimeEvent) {
    const session = this.sessions.get(threadId);
    this.persistVendorSession(threadId);

    switch (event.type) {
      case "assistant.delta":
        if (session) {
          session.partialByTurn.set(
            event.turnId,
            (session.partialByTurn.get(event.turnId) ?? "") + event.text,
          );
        }
        this.bus.delta(threadId, event.turnId, event.text);
        return;

      case "assistant.message":
        if (session?.committedAssistant.has(event.turnId)) return;
        session?.committedAssistant.add(event.turnId);
        session?.partialByTurn.delete(event.turnId);
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

      case "usage.reported": {
        const inputTokens = finiteToken(event.inputTokens);
        const outputTokens = finiteToken(event.outputTokens);
        const totalTokens = finiteToken(event.totalTokens);
        const cacheReadTokens = finiteToken(event.cacheReadTokens);
        const cacheWriteTokens = finiteToken(event.cacheWriteTokens);
        if (
          inputTokens === undefined &&
          outputTokens === undefined &&
          totalTokens === undefined &&
          cacheReadTokens === undefined &&
          cacheWriteTokens === undefined
        ) {
          return;
        }
        const model = this.store.getThread(threadId)?.model;
        this.commit([
          {
            type: "turn.usage",
            threadId,
            payload: {
              threadId,
              turnId: event.turnId,
              ...(session?.provider ? { provider: session.provider } : {}),
              ...(model ? { model } : {}),
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
              ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            },
          },
        ]);
        return;
      }

      case "turn.completed":
        if (session) this.flushPartialAssistant(session, threadId, event.turnId);
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
        this.persistVendorSession(threadId);
        this.sessions.delete(threadId);
        this.commit([{ type: "session.status", threadId, payload: { threadId, status: "closed" } }]);
        return;

      case "error": {
        const turnId = session?.activeTurnId ?? session?.stoppingTurnId;
        if (turnId && session?.stoppingTurnId === turnId) {
          // SIGTERM after Stop often surfaces as a provider `is_error` result.
          this.flushPartialAssistant(session, threadId, turnId);
          return;
        }
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
      this.persistVendorSession(threadId);
      const adapter = this.registry.get(session.provider);
      try {
        await adapter?.stopSession(session.handle);
      } catch (err) {
        log.warn("failed to stop session", { threadId, err: String(err) });
      }
      const status = session.activeTurnId ? "error" : "ready";
      this.commit([{ type: "session.status", threadId, payload: { threadId, status } }]);
    }
    this.sessions.clear();
  }

  /**
   * After a crash the projection can still say `running` / `connecting` while
   * no LiveSession exists. Reset those before we accept commands so Stop/Send
   * are not lying.
   */
  reconcileAfterCrash(): void {
    const live: SessionStatus[] = ["connecting", "running", "stopping", "awaiting_approval"];
    for (const thread of this.store.listThreads()) {
      if (!live.includes(thread.status)) continue;
      this.commit([
        { type: "session.status", threadId: thread.id, payload: { threadId: thread.id, status: "error" } },
      ]);
    }
    for (const lane of this.store.listLanes()) {
      if (lane.status !== "preparing") continue;
      this.commit([
        {
          type: "lane.status",
          threadId: null,
          payload: {
            laneId: lane.id,
            status: "error",
            detail: "Daemon restarted during setup. Archive this lane or create it again.",
          },
        },
      ]);
    }
  }
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function writeTurnImages(
  root: string,
  images: Array<{ name: string; mimeType: string; dataBase64: string }>,
): Promise<string[]> {
  const dirRel = join(".divisio", "attachments");
  await mkdir(join(root, dirRel), { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    if (!img.mimeType.startsWith("image/")) {
      throw new CommandError("invalid_payload", `not an image: ${img.mimeType}`);
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(img.dataBase64, "base64");
    } catch {
      throw new CommandError("invalid_payload", "invalid image payload");
    }
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) {
      throw new CommandError("invalid_payload", "image must be between 1 byte and 5 MB");
    }
    const safe = (img.name || "image.png").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const rel = join(dirRel, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    await writeFile(join(root, rel), buf);
    paths.push(rel.replace(/\\/g, "/"));
  }
  return paths;
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
