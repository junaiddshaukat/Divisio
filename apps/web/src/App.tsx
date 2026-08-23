import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiffFileEntry,
  DomainEvent,
  FileTreeEntry,
  LaneView,
  PairingStatus,
  PrResult,
  MessageView,
  PermissionMode,
  ProjectView,
  ProviderView,
  ProviderUpdate,
  ModelCatalog,
  ThreadView,
  DaemonIncompatibility,
  UsageRangeDays,
  VendorResumeOutcome,
} from "@divisio/contracts";
import { looksLikeUsageLimit } from "@divisio/shared/usageLimit";
import { changedRangesForFile, type FileChangeMarks } from "./lib/changedRanges.ts";
import { Client, type ConnectionState } from "./client.ts";
import { useFiles } from "./hooks/useFiles.ts";
import { useAttention } from "./hooks/useAttention.ts";
import { AttentionToasts } from "./components/AttentionToasts.tsx";
import { UpdateToast } from "./components/UpdateToast.tsx";
import { Onboarding } from "./components/onboarding/Onboarding.tsx";
import { LandingEmpty } from "./components/onboarding/LandingEmpty.tsx";
import { BrandMark } from "./components/BrandMark.tsx";
import { pickDirectory, reloadApp } from "./platform.ts";
import { AddProjectDialog } from "./components/AddProjectDialog.tsx";
import { ApprovalBar, type PendingApproval } from "./components/ApprovalBar.tsx";
import { Composer } from "./components/Composer.tsx";
import { ConfirmHost } from "./components/ConfirmDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import type { WorkEntry } from "./components/WorkEntries.tsx";
import { Transcript, type Bubble } from "./components/Transcript.tsx";
import { NewThreadDialog } from "./components/NewThreadDialog.tsx";
import { SessionBoard } from "./components/SessionBoard.tsx";
import { ThreadTopbar, TopbarLead } from "./components/ThreadTopbar.tsx";
import { UsageLimitBanner } from "./components/UsageLimitBanner.tsx";
import { Button, IconButton } from "./components/ui/Button.tsx";
import { CloseIcon } from "./components/ui/icons.ts";
import { SettingsShell, type SettingsSection } from "./components/SettingsShell.tsx";

/**
 * Monaco is ~4 MB, so it is not in the first-paint bundle — that would delay
 * startup for everyone, including users who never open a file.
 *
 * It is not merely deferred, though: once the app is idle the chunk is fetched
 * in the background, so opening the file pane is instant rather than showing a
 * spinner. Fast start and an instant editor, instead of trading one for the other.
 */
const loadFilePane = () => import("./components/FilePane.tsx");
// xterm carries its own CSS and addons; same reasoning as the editor.
const TerminalPane = lazy(() =>
  import("./components/TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })),
);
const FilePane = lazy(() => loadFilePane().then((m) => ({ default: m.FilePane })));

let editorPrefetched = false;
function prefetchEditor() {
  if (editorPrefetched) return;
  editorPrefetched = true;
  void loadFilePane().catch(() => {
    // A failed prefetch is not a failure: opening the pane retries for real.
    editorPrefetched = false;
  });
}
import { TurnDiff } from "./components/TurnDiff.tsx";
import { ChangesPane, type ChangesScope } from "./components/ChangesPane.tsx";
import { BranchStrip } from "./components/BranchStrip.tsx";
import { BrowserPane } from "./components/BrowserPane.tsx";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette.tsx";
import { GitActionsControl } from "./components/GitActionsControl.tsx";
import { RightPanel, type RightSurfaceId } from "./components/RightPanel.tsx";
import { RightSurfacePicker, type RightSurface } from "./components/RightSurfacePicker.tsx";
import {
  clampLeft,
  clampTerminal,
  LEFT_DEFAULT,
  loadTerminalHeight,
  loadWidth,
  saveTerminalHeight,
  saveWidth,
  TERMINAL_DEFAULT,
} from "./panelPrefs.ts";
import { isProviderEnabled, loadProviderPrefs } from "./providerPrefs.ts";

const PORT = 4577;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

/**
 * Streaming commit budget. Tokens arrive far faster than a useful repaint;
 * batching them into ~10 commits/sec keeps the transcript readable without
 * making first token wait (the first chunk of a turn bypasses this).
 */
const STREAM_FLUSH_MS = 100;

const LIVE_THREAD_STATUS = new Set(["running", "stopping", "awaiting_approval"]);

/** Active chat plus every thread still mid-turn — so background streams keep arriving. */
function subscriptionThreadIds(activeId: string | null, threads: ThreadView[]): string[] {
  const ids = new Set<string>();
  if (activeId) ids.add(activeId);
  for (const t of threads) {
    if (LIVE_THREAD_STATUS.has(t.status)) ids.add(t.id);
  }
  return [...ids];
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readTokenSync(): string {
  // Desktop: never trust the webview's leftover token. A previous paste, a
  // pairing session, or an older daemon writes `divisio:token` and then every
  // /ws upgrade is rejected as bad_token while the chip sits on Connecting.
  if (isTauri()) return "";
  const fromEnv = import.meta.env["VITE_DIVISIO_TOKEN"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return localStorage.getItem("divisio:token") ?? "";
}

async function readDaemonToken(): Promise<string> {
  if (!isTauri()) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const token = await invoke<string>("auth_token");
    if (token) {
      localStorage.setItem("divisio:token", token);
      return token;
    }
  } catch {
    /* daemon may still be booting */
  }
  return "";
}

async function readDaemonError(): Promise<string> {
  if (!isTauri()) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("daemon_error")) ?? "";
  } catch {
    return "";
  }
}

/**
 * Reads a single-use pairing token out of the URL fragment.
 *
 * The fragment, not the query string: a fragment is never sent to the server in
 * a request line and does not land in access logs or Referer headers.
 */
function pairingTokenFromUrl(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#pair=")) return null;
  const token = hash.slice("#pair=".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Exchanges a pairing token for this device's own session token.
 *
 * Called once, on load, before any WebSocket attempt. The pairing token is
 * consumed by the daemon on first use, so the fragment is cleared immediately
 * whether the exchange succeeded or not — leaving a spent credential in the
 * address bar invites it into screenshots and browser history.
 */
async function redeemPairing(token: string): Promise<string> {
  const label = `${navigator.platform || "device"} · ${new Date().toLocaleDateString()}`;
  try {
    const res = await fetch("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, label }),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? "That pairing link has already been used or has expired. Generate a new one on the host."
          : `Pairing failed (${res.status}).`,
      );
    }
    const body = (await res.json()) as { token: string };
    return body.token;
  } finally {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function upsertAssistantMessage(prev: MessageView[], incoming: MessageView): MessageView[] {
  const idx = prev.findIndex((m) => m.turnId === incoming.turnId && m.role === incoming.role);
  if (idx === -1) return [...prev, incoming];
  if (incoming.role === "assistant" && incoming.text.length > prev[idx]!.text.length) {
    const next = prev.slice();
    next[idx] = incoming;
    return next;
  }
  return prev;
}

export function App() {
  const [token, setToken] = useState(readTokenSync);
  // Non-null only while a pairing link is being exchanged on first load.
  const [pairingToken] = useState(pairingTokenFromUrl);
  const [pairingState, setPairingState] = useState<"idle" | "pairing" | "failed">(
    pairingTokenFromUrl() ? "pairing" : "idle",
  );
  const [bootError, setBootError] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [cliUpdates, setCliUpdates] = useState<ProviderUpdate[]>([]);
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ModelCatalog>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<{ turnId: string; text: string } | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  /**
   * User bubble shown before the daemon echoes `turn.message` back.
   *
   * The composer clears on submit, so without this the typed text vanished
   * and nothing rendered until a full round trip (spawn + checkpoint) landed.
   * Reconciled by turnId once the server copy arrives.
   */
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  /** Stop was pressed; flip the UI now rather than after the daemon replies. */
  const [stopping, setStopping] = useState(false);
  /** Pending coalesced streaming commit. See `onDelta`. */
  const streamingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [work, setWork] = useState<WorkEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  /** When opening New chat from a project row (or lane), lock to that project. */
  const [threadProjectId, setThreadProjectId] = useState<string | null>(null);
  /**
   * First run is decided by state, not by a stored "seen" flag: a user with no
   * projects has nothing to return to, and one who dismissed it keeps that
   * choice. Re-runnable from Settings if they want it back.
   */
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => localStorage.getItem("divisio:onboarded") === "1",
  );
  /** Settings → General can reopen welcome even when projects already exist. */
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [lanes, setLanes] = useState<LaneView[]>([]);
  const [view, setView] = useState<"thread" | "board">("thread");
  /** Set when the new-thread dialog was opened from a lane card. */
  const [laneForNewThread, setLaneForNewThread] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [incompatible, setIncompatible] = useState<DaemonIncompatibility | null>(null);
  const [pairing, setPairing] = useState<PairingStatus | null>(null);
  const [rightSurface, setRightSurface] = useState<RightSurfaceId | null>(null);
  /** Bottom dock under the composer — the only terminal. */
  const [terminalDock, setTerminalDock] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(() => loadTerminalHeight(TERMINAL_DEFAULT));
  const [draftProvider, setDraftProvider] = useState("claude");
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftPermission, setDraftPermission] = useState<PermissionMode>("supervised");
  const [draftProjectId, setDraftProjectId] = useState("");
  const [landingBusy, setLandingBusy] = useState(false);

  useEffect(() => {
    const onResize = () => setTerminalHeight((h) => clampTerminal(h));
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() => clampLeft(loadWidth("left", LEFT_DEFAULT)));
  /** Sidebar is an overlay below tablet width; this drives it. */
  const [navOpen, setNavOpen] = useState(false);
  /** Sidebar starts open. Hide/show is always in the window title bar. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [laneBusy, setLaneBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  /** turnId → files from checkpoint; hydrated from snapshot + live events. */
  const [diffByTurn, setDiffByTurn] = useState<Map<string, DiffFileEntry[]>>(new Map());
  const [changesBusy, setChangesBusy] = useState(false);
  const [changesScope, setChangesScope] = useState<ChangesScope>("working");
  const [gitStatus, setGitStatus] = useState<{
    dirty: boolean;
    branch: string | null;
    laneId: string | null;
    hasRemote: boolean;
    git: boolean;
  } | null>(null);
  const [changesView, setChangesView] = useState<{
    turnId: string | null;
    files: DiffFileEntry[];
    patch: string | null;
    status: string;
    detail?: string;
    preferredPath?: string;
    branch?: string | null;
  } | null>(null);
  const [diffView, setDiffView] = useState<{
    turnId: string;
    files: DiffFileEntry[];
    patch: string | null;
    status: string;
    detail?: string;
  } | null>(null);

  const clientRef = useRef<Client | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const streamingByThreadRef = useRef(new Map<string, { turnId: string; text: string }>());

  /**
   * Streaming coalescer.
   *
   * One React commit per `STREAM_FLUSH_MS` instead of one per token. The
   * accumulated text already lives in `streamingByThreadRef`, so a flush just
   * republishes the latest value for the active thread.
   */
  const flushStreaming = useCallback(() => {
    if (streamingFlushRef.current !== null) {
      clearTimeout(streamingFlushRef.current);
      streamingFlushRef.current = null;
    }
    const active = activeIdRef.current;
    if (!active) return;
    const next = streamingByThreadRef.current.get(active);
    if (next) setStreaming(next);
  }, []);

  const scheduleStreamingFlush = useCallback(() => {
    if (streamingFlushRef.current !== null) return;
    streamingFlushRef.current = setTimeout(() => {
      streamingFlushRef.current = null;
      const active = activeIdRef.current;
      if (!active) return;
      const next = streamingByThreadRef.current.get(active);
      if (next) setStreaming(next);
    }, STREAM_FLUSH_MS);
  }, []);

  // A pending flush must not outlive the component or fire after a thread swap.
  useEffect(() => {
    return () => {
      if (streamingFlushRef.current !== null) clearTimeout(streamingFlushRef.current);
    };
  }, []);

  const activeThread = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);
  const threadRunning = !!activeThread && LIVE_THREAD_STATUS.has(activeThread.status);
  /** Stop / disable send — status can lag behind events, so OR both signals. */
  // `pendingUserText` keeps the composer busy across the send round trip, so
  // the Stop button is armed from the moment the user submits.
  const turnBusy = !!activeTurn || threadRunning || handoffBusy || pendingUserText !== null;

  const refresh = useCallback(async (client: Client) => {
    const list = await client.send("project.list", {});
    setProjects(list.projects);
    setThreads(list.threads);
    const laneList = await client.send("lane.list", {});
    setLanes(laneList.lanes);
  }, []);

  const createLane = useCallback(async (projectId: string, title: string) => {
    const client = clientRef.current;
    if (!client) return;
    setLaneBusy(true);
    try {
      await client.send("lane.create", { projectId, title });
      await refresh(client);
    } finally {
      setLaneBusy(false);
    }
  }, []);

  /** Reuses the turn diff viewer; a lane diff is the same shape of data. */
  const showLaneDiff = useCallback(async (laneId: string) => {
    const client = clientRef.current;
    if (!client) return;
    const lane = await client.send("lane.diff", { laneId });
    setDiffView({
      turnId: laneId,
      files: lane.files,
      patch: lane.patch,
      status: lane.status,
    });
  }, []);

  const openLanePr = useCallback(
    async (laneId: string, title: string, commitMessage?: string): Promise<PrResult> => {
      const client = clientRef.current;
      if (!client) throw new Error("not connected");
      const result = await client.send("lane.openPr", {
        laneId,
        title,
        body: "Opened from Divisio.",
        ...(commitMessage ? { commitMessage } : {}),
      });
      await refresh(client);
      return result;
    },
    [],
  );

  const archiveLane = useCallback(async (laneId: string, deleteBranch: boolean, force: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    await client.send("lane.archive", { laneId, deleteBranch, force });
    await refresh(client);
  }, []);

  const [providersLoading, setProvidersLoading] = useState(false);

  const refreshProviders = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setProvidersLoading(true);
    try {
      const r = await client.send("provider.detect", {});
      setProviders(r.providers);
      try {
        const models = await client.send("provider.models", {});
        setModelCatalogs(models.catalogs);
      } catch {
        setModelCatalogs({});
      }
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setActiveId(threadId);
    setStreaming(streamingByThreadRef.current.get(threadId) ?? null);
    setWork([]);
    setActiveTurn(null);
    setError(null);
    setPendingApproval(null);
    setDiffByTurn(new Map());
    setChangesView(null);
    setGitStatus(null);
    const snap = await client.send("thread.snapshot", { threadId });
    if (activeIdRef.current !== threadId) return;
    setMessages(snap.messages);
    setThreads((prev) => prev.map((t) => (t.id === snap.thread.id ? snap.thread : t)));
    // Restore Stop/busy after refresh or handoff — turn.started may already have fired.
    const running =
      snap.thread.status === "running" ||
      snap.thread.status === "stopping" ||
      snap.thread.status === "awaiting_approval";
    const restoredTurn =
      snap.activeTurnId ??
      (running
        ? [...snap.messages].reverse().find((m) => m.role === "user")?.turnId ?? null
        : null);
    setActiveTurn(restoredTurn);
    if (snap.partial?.text) {
      const local = streamingByThreadRef.current.get(threadId);
      const buf =
        local?.turnId === snap.partial.turnId && local.text.length > snap.partial.text.length
          ? local
          : { turnId: snap.partial.turnId, text: snap.partial.text };
      streamingByThreadRef.current.set(threadId, buf);
      setStreaming(buf);
    } else if (!running) {
      streamingByThreadRef.current.delete(threadId);
      setStreaming(null);
    }
    const next = new Map<string, DiffFileEntry[]>();
    for (const d of snap.diffs) {
      if (d.files.length > 0) next.set(d.turnId, d.files);
    }
    setDiffByTurn(next);
    try {
      setGitStatus(await client.send("thread.gitStatus", { threadId }));
    } catch {
      setGitStatus(null);
    }
  }, []);

  const onEvent = useCallback(
    (event: DomainEvent) => {
      const p = event.payload as Record<string, unknown>;
      switch (event.type) {
        case "turn.message": {
          const threadId = String(p["threadId"]);
          if (p["role"] === "assistant") streamingByThreadRef.current.delete(threadId);
          if (threadId !== activeIdRef.current) break;
          const msg: MessageView = {
            turnId: String(p["turnId"]),
            role: p["role"] as "user" | "assistant",
            text: String(p["text"]),
            at: event.at,
          };
          setMessages((prev) => upsertAssistantMessage(prev, msg));
          if (msg.role === "assistant") setStreaming(null);
          // The server's copy of the user message supersedes the optimistic one.
          if (msg.role === "user" && p["threadId"] === activeIdRef.current) {
            setPendingUserText(null);
          }
          break;
        }
        case "turn.started":
          if (p["threadId"] === activeIdRef.current) {
            setActiveTurn(String(p["turnId"]));
            setWork([]);
            setPendingApproval(null);
          }
          break;
        case "turn.completed":
        case "turn.interrupted":
        case "turn.failed": {
          const threadId = String(p["threadId"]);
          const streamed = streamingByThreadRef.current.get(threadId);
          streamingByThreadRef.current.delete(threadId);
          if (threadId !== activeIdRef.current) break;
          if (streamed?.text) {
            setMessages((prev) =>
              upsertAssistantMessage(prev, {
                turnId: streamed.turnId,
                role: "assistant",
                text: streamed.text,
                at: event.at,
              }),
            );
          }
          setActiveTurn(null);
          setStreaming(null);
          setPendingApproval(null);
          setStopping(false);
          setPendingUserText(null);
          if (event.type === "turn.failed") setError(String(p["message"]));
          break;
        }
        case "tool.started":
          if (p["threadId"] === activeIdRef.current) {
            setWork((w) => [
              ...w,
              {
                id: String(p["toolCallId"] ?? `${w.length}`),
                name: String(p["name"] ?? "tool"),
                status: "running",
                ...(p["input"] ? { detail: String(p["input"]).slice(0, 400) } : {}),
              },
            ]);
          }
          break;
        case "tool.finished":
          if (p["threadId"] === activeIdRef.current) {
            const id = String(p["toolCallId"] ?? "");
            setWork((w) =>
              w.map((e) =>
                e.id === id
                  ? {
                      ...e,
                      status: p["ok"] === false ? "failed" : "ok",
                      ...(p["output"] ? { output: String(p["output"]).slice(0, 4000) } : {}),
                    }
                  : e,
              ),
            );
          }
          break;
        case "approval.requested":
          if (p["threadId"] === activeIdRef.current) {
            setPendingApproval({
              approvalId: String(p["approvalId"]),
              turnId: String(p["turnId"]),
              category: String(p["category"]),
              summary: String(p["summary"]),
            });
          }
          break;
        case "approval.resolved":
          if (p["threadId"] === activeIdRef.current) {
            setPendingApproval((cur) =>
              cur?.approvalId === p["approvalId"] ? null : cur,
            );
          }
          break;
        case "turn.diff_ready":
          if (p["threadId"] === activeIdRef.current) {
            const turnId = String(p["turnId"]);
            const files = (Array.isArray(p["files"]) ? p["files"] : []) as DiffFileEntry[];
            setDiffByTurn((prev) => {
              const next = new Map(prev);
              next.set(turnId, files);
              return next;
            });
            void clientRef.current
              ?.send("thread.gitStatus", { threadId: String(p["threadId"]) })
              .then(setGitStatus)
              .catch(() => undefined);
          }
          break;
        case "session.status":
          setThreads((prev) =>
            prev.map((t) => (t.id === p["threadId"] ? { ...t, status: p["status"] as never } : t)),
          );
          {
            const threadId = String(p["threadId"]);
            const status = String(p["status"]);
            const settled = status === "ready" || status === "closed" || status === "error";
            if (settled) streamingByThreadRef.current.delete(threadId);
            if (threadId === activeIdRef.current) {
              if (settled || status === "connecting") {
                const streamed = streamingRef.current;
                if (streamed?.text && status !== "connecting") {
                  setMessages((prev) =>
                    upsertAssistantMessage(prev, {
                      turnId: streamed.turnId,
                      role: "assistant",
                      text: streamed.text,
                      at: event.at,
                    }),
                  );
                }
                setActiveTurn(null);
                setStreaming(null);
              }
              if (status === "error") {
                setError(String(p["detail"] ?? "session error"));
              }
            }
          }
          break;
        case "thread.permission_mode_set":
          setThreads((prev) =>
            prev.map((t) =>
              t.id === p["threadId"] ? { ...t, permissionMode: p["mode"] as PermissionMode } : t,
            ),
          );
          break;
        case "thread.vendor_session_set":
          setThreads((prev) =>
            prev.map((t) =>
              t.id === p["threadId"] ? { ...t, vendorSessionId: String(p["nativeId"]) } : t,
            ),
          );
          break;
        case "session.resume_outcome":
          setThreads((prev) =>
            prev.map((t) =>
              t.id === p["threadId"]
                ? { ...t, vendorResume: p["outcome"] as VendorResumeOutcome }
                : t,
            ),
          );
          break;
        case "project.created":
        case "project.removed":
        case "thread.created":
        case "thread.renamed":
        case "thread.deleted":
          void (clientRef.current && refresh(clientRef.current));
          if (event.type === "thread.deleted") {
            streamingByThreadRef.current.delete(String(p["threadId"]));
            if (p["threadId"] === activeIdRef.current) {
              setActiveId(null);
              setMessages([]);
              setStreaming(null);
              setActiveTurn(null);
              setWork([]);
            }
          }
          if (event.type === "project.removed") {
            const removedId = p["projectId"] as string;
            setProjects((prev) => prev.filter((pr) => pr.id !== removedId));
            setThreads((prev) => {
              const open = prev.find((t) => t.id === activeIdRef.current);
              if (open?.projectId === removedId) {
                setActiveId(null);
                setMessages([]);
                setStreaming(null);
                setActiveTurn(null);
                setWork([]);
              }
              return prev.filter((t) => t.projectId !== removedId);
            });
            setLanes((prev) => prev.filter((l) => l.projectId !== removedId));
          }
          break;
      }
    },
    [refresh],
  );

  // Desktop shell injects the userdata token — no paste gate.
  // Do not skip this when localStorage already has a value: that leftover is
  // what produced the bad_token storm after a daemon restart.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const boot = async () => {
      for (let i = 0; i < 40; i++) {
        const next = await readDaemonToken();
        if (cancelled) return;
        if (next) {
          if (next !== tokenRef.current) setToken(next);
          setBootError(null);
          return;
        }
        const err = await readDaemonError();
        if (err && !cancelled) setBootError(err);
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!cancelled && !tokenRef.current) {
        setBootError(
          (await readDaemonError()) ||
            "Could not reach the Divisio daemon. Stop whatever is using port 4577 and reopen Divisio.",
        );
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;

  useEffect(() => {
    if (!token) return;
    const client = new Client(WS_URL, token, {
      onEvent: (event) => onEventRef.current(event),
      onDelta: (threadId, turnId, text) => {
        const prev = streamingByThreadRef.current.get(threadId);
        const isFirstChunk = prev?.turnId !== turnId;
        const next = isFirstChunk ? { turnId, text } : { turnId, text: prev.text + text };
        streamingByThreadRef.current.set(threadId, next);
        if (threadId !== activeIdRef.current) return;
        // Deltas arrive per token. Committing each one re-rendered the whole
        // app, so coalesce into one commit per frame budget — except the first
        // chunk of a turn, which paints immediately so first token is not
        // delayed by the coalescing window.
        if (isFirstChunk) {
          flushStreaming();
          setStreaming(next);
          return;
        }
        scheduleStreamingFlush();
      },
      onIncompatible: setIncompatible,
      onState: setState,
      onHandshakeFailed: () => {
        if (!isTauri()) return;
        void (async () => {
          const next = await readDaemonToken();
          if (next && next !== tokenRef.current) setToken(next);
        })();
      },
      onResync: () => {
        const id = activeIdRef.current;
        void refreshRef.current(client);
        if (id) void openThreadRef.current(id);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [token]);

  // Redeem a pairing link before anything tries to connect.
  useEffect(() => {
    if (!pairingToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const sessionToken = await redeemPairing(pairingToken);
        if (cancelled) return;
        localStorage.setItem("divisio:token", sessionToken);
        setToken(sessionToken);
        setPairingState("idle");
      } catch (err) {
        if (cancelled) return;
        setBootError(err instanceof Error ? err.message : String(err));
        setPairingState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pairingToken]);

  // Warm the editor once the app is idle, so the first open has nothing to wait for.
  useEffect(() => {
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(prefetchEditor, { timeout: 4000 })
      : window.setTimeout(prefetchEditor, 1500);
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle as number);
      else clearTimeout(idle as number);
    };
  }, []);

  useEffect(() => {
    const sync = () => setDark(document.documentElement.classList.contains("dark"));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);
    window.addEventListener("divisio:theme", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("divisio:theme", sync);
    };
  }, []);

  useEffect(() => {
    if (state !== "open") return;
    const client = clientRef.current;
    if (!client) return;
    void refresh(client);
    void refreshProviders();
  }, [state, refresh, refreshProviders]);

  useEffect(() => {
    if (state !== "open") {
      setCliUpdates([]);
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    let cancelled = false;
    void client
      .send("provider.updates", {})
      .then((r) => {
        if (!cancelled) setCliUpdates(r.updates);
      })
      .catch(() => {
        if (!cancelled) setCliUpdates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || state !== "open") return;
    client.subscribe(subscriptionThreadIds(activeId, threads));
  }, [activeId, threads, state, token]);

  const send = async (
    text: string,
    model: string | null,
    images: Array<{ name: string; mimeType: string; dataBase64: string }> = [],
  ) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setError(null);
    // Paint the user's message immediately. The daemon still has to spawn or
    // reconfigure the CLI and take a pre-turn checkpoint before it echoes this
    // back, and waiting for that read as a dropped message.
    setPendingUserText(text);
    setStopping(false);
    try {
      const res = await client.send("turn.send", {
        threadId: activeId,
        text,
        ...(model ? { model } : {}),
        ...(images.length ? { images } : {}),
      });
      setActiveTurn(res.turnId);
    } catch (err) {
      setPendingUserText(null);
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const setThreadAgent = async (next: {
    provider: string;
    model: string | null;
    viaHandoff: boolean;
  }) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setError(null);
    if (next.viaHandoff) {
      const created = await handoff(next.provider);
      if (created && next.model) {
        try {
          const res = await client.send("thread.setProvider", {
            threadId: created.id,
            provider: next.provider,
            model: next.model,
          });
          setThreads((prev) => prev.map((t) => (t.id === res.thread.id ? res.thread : t)));
        } catch {
          /* handoff already succeeded; model is best-effort */
        }
      }
      return;
    }
    try {
      const res = await client.send("thread.setProvider", {
        threadId: activeId,
        provider: next.provider,
        model: next.model,
      });
      setThreads((prev) => prev.map((t) => (t.id === res.thread.id ? res.thread : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const interrupt = async () => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    const turnId =
      activeTurn ??
      [...messages].reverse().find((m) => m.role === "user")?.turnId ??
      null;
    if (!turnId) {
      setError("Nothing to stop — no active turn id yet.");
      return;
    }
    // Flip the UI before the round trip. The daemon's ack is bounded by the
    // adapter's own stop path, which is well past the 150ms budget in
    // docs/architecture/performance.md.
    setStopping(true);
    try {
      await client.send("turn.interrupt", { threadId: activeId, turnId });
    } catch (err) {
      setStopping(false);
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const respondApproval = async (decision: "approve" | "deny") => {
    const client = clientRef.current;
    if (!client || !activeId || !pendingApproval) return;
    try {
      await client.send("approval.respond", {
        threadId: activeId,
        approvalId: pendingApproval.approvalId,
        decision,
      });
      setPendingApproval(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const setPermissionMode = async (mode: PermissionMode) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    try {
      const res = await client.send("thread.setPermissionMode", { threadId: activeId, mode });
      setThreads((prev) => prev.map((t) => (t.id === res.thread.id ? res.thread : t)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  /** Latest `showDiff`, so the stable callback below never goes stale. */
  const showDiffRef = useRef<(turnId: string, path?: string) => void>(() => {});
  const openFileRef = useRef<(turnId: string, path: string) => void>(() => {});
  /** File the transcript asked the editor to open, with the lines to highlight. */
  const [fileFocus, setFileFocus] = useState<{
    path: string;
    marks: FileChangeMarks;
    token: number;
  } | null>(null);
  /**
   * Open a file the agent changed, with that turn's edits highlighted.
   *
   * The patch is fetched per click rather than cached: a turn's diff is only
   * wanted when someone asks for it, and it can be large. If the patch cannot
   * be read the file still opens — losing the highlight is a much smaller
   * failure than refusing to show the file.
   */
  const openChangedFile = async (turnId: string, path: string) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setRightSurface("files");
    setFileFocus({ path, marks: { ranges: [], deletedAt: [] }, token: Date.now() });
    try {
      const res = await client.send("turn.diff", { threadId: activeId, turnId });
      setFileFocus({
        path,
        marks: changedRangesForFile(res.patch, path),
        token: Date.now(),
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const showDiff = async (turnId: string, path?: string) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setRightSurface("changes");
    setChangesScope("turn");
    setChangesBusy(true);
    try {
      const res = await client.send("turn.diff", { threadId: activeId, turnId });
      setChangesView({
        turnId,
        files: res.files,
        patch: res.patch,
        status: res.status,
        detail: res.detail,
        ...(path ? { preferredPath: path } : {}),
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setChangesBusy(false);
    }
  };

  const loadScopedDiff = useCallback(async (scope: "working" | "branch") => {
    const client = clientRef.current;
    const threadId = activeIdRef.current;
    if (!client || !threadId) return;
    setChangesBusy(true);
    try {
      const res = await client.send("thread.diff", { threadId, scope });
      setChangesView({
        turnId: null,
        files: res.files,
        patch: res.patch,
        status: res.status,
        detail: res.detail,
        branch: res.branch,
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setChangesBusy(false);
    }
  }, []);

  const refreshGitStatus = useCallback(async () => {
    const client = clientRef.current;
    const threadId = activeIdRef.current;
    if (!client || !threadId) {
      setGitStatus(null);
      return;
    }
    try {
      setGitStatus(await client.send("thread.gitStatus", { threadId }));
    } catch {
      setGitStatus(null);
    }
  }, []);

  const openSurface = (surface: RightSurface | "picker") => {
    setRightSurface(surface);
    if (surface === "changes") {
      setChangesScope("working");
      void loadScopedDiff("working");
      void refreshGitStatus();
    }
  };

  const closeRight = () => {
    setRightSurface(null);
    setChangesView(null);
  };

  const commitThread = async (message: string, paths?: string[]) => {
    const client = clientRef.current;
    if (!client || !activeId) return { ok: false, detail: "not connected" };
    const res = await client.send("thread.commit", {
      threadId: activeId,
      message,
      ...(paths?.length ? { paths } : {}),
    });
    await refreshGitStatus();
    if (rightSurface === "changes" && changesScope === "working") void loadScopedDiff("working");
    return res;
  };

  const pushThread = async () => {
    const client = clientRef.current;
    if (!client || !activeId) return { ok: false, detail: "not connected" };
    const res = await client.send("thread.push", { threadId: activeId });
    await refreshGitStatus();
    return res;
  };

  const openThreadPr = async (title: string, commitMessage?: string) => {
    const client = clientRef.current;
    if (!client || !activeThread?.laneId) {
      return { status: "error", url: null, compareUrl: null, branch: "", detail: "thread has no lane" };
    }
    const result = await client.send("lane.openPr", {
      laneId: activeThread.laneId,
      title,
      body: "Opened from Divisio.",
      ...(commitMessage ? { commitMessage } : {}),
    });
    await refresh(client);
    await refreshGitStatus();
    return result;
  };

  const createThread = async (projectId: string, title: string, provider: string) => {
    const client = clientRef.current;
    if (!client) return;
    const res = await client.send("thread.create", {
      projectId,
      title,
      provider,
      ...(laneForNewThread ? { laneId: laneForNewThread } : {}),
    });
    setDialog(false);
    setLaneForNewThread(null);
    setThreadProjectId(null);
    await refresh(client);
    setView("thread");
    await openThread(res.thread.id);
  };

  const cloneProject = useCallback(
    async (url: string, parentPath: string, name?: string) => {
      const client = clientRef.current;
      if (!client) return null;
      const res = await client.send("project.clone", { url, parentPath, ...(name ? { name } : {}) });
      await refresh(client);
      return res.project;
    },
    [refresh],
  );

  const openNewThread = useCallback((projectId?: string | null) => {
    setThreadProjectId(projectId ?? null);
    setLaneForNewThread(null);
    setDialog(true);
  }, []);

  useEffect(() => {
    const prefs = loadProviderPrefs();
    const available = providers.filter((p) => p.available && isProviderEnabled(p.kind, prefs));
    if (available.length === 0) return;
    setDraftProvider((current) => {
      if (available.some((p) => p.kind === current)) return current;
      const saved = localStorage.getItem("divisio:draft-provider");
      return available.find((p) => p.kind === saved)?.kind ?? available[0].kind;
    });
  }, [providers]);

  useEffect(() => {
    if (projects.length === 0) return;
    setDraftProjectId((current) => {
      if (current && projects.some((p) => p.id === current)) return current;
      const saved = localStorage.getItem("divisio:draft-project");
      const fromThread = threads[0]?.projectId;
      return (
        projects.find((p) => p.id === saved)?.id ??
        projects.find((p) => p.id === fromThread)?.id ??
        projects[0].id
      );
    });
  }, [projects, threads]);

  const createAndSend = useCallback(async (input: {
    projectId: string;
    provider: string;
    model: string | null;
    permissionMode: PermissionMode;
    text: string;
    images: Array<{ name: string; mimeType: string; dataBase64: string }>;
  }) => {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    const title =
      input.text.length > 48 ? `${input.text.slice(0, 48)}…` : input.text.trim() || "New chat";
    const res = await client.send("thread.create", {
      projectId: input.projectId,
      title,
      provider: input.provider,
    });
    if (input.permissionMode !== "supervised") {
      await client.send("thread.setPermissionMode", {
        threadId: res.thread.id,
        mode: input.permissionMode,
      });
    }
    if (input.model) {
      await client.send("thread.setProvider", {
        threadId: res.thread.id,
        provider: input.provider,
        model: input.model,
      });
    }
    await refresh(client);
    setView("thread");
    await openThread(res.thread.id);
    const turn = await client.send("turn.send", {
      threadId: res.thread.id,
      text: input.text,
      ...(input.model ? { model: input.model } : {}),
      ...(input.images.length ? { images: input.images } : {}),
    });
    setActiveTurn(turn.turnId);
  }, [openThread, refresh]);

  const sendFromLanding = async (
    text: string,
    model: string | null,
    images: Array<{ name: string; mimeType: string; dataBase64: string }>,
  ) => {
    if (projects.length === 0) {
      setAddProjectOpen(true);
      return;
    }
    const projectId = draftProjectId || projects[0].id;
    setLandingBusy(true);
    setError(null);
    try {
      localStorage.setItem("divisio:draft-provider", draftProvider);
      localStorage.setItem("divisio:draft-project", projectId);
      await createAndSend({
        projectId,
        provider: draftProvider,
        model,
        permissionMode: draftPermission,
        text,
        images,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLandingBusy(false);
    }
  };

  const setSidebarHidden = useCallback((hidden: boolean) => {
    localStorage.setItem("divisio:sidebar-collapsed", hidden ? "1" : "0");
    setSidebarCollapsed(hidden);
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarHidden(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarHidden]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const res = await client.send("thread.rename", { threadId, title });
      setThreads((prev) => prev.map((t) => (t.id === res.thread.id ? res.thread : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const deleteThread = useCallback(
    async (threadId: string) => {
      const client = clientRef.current;
      if (!client) return;
      try {
        await client.send("thread.delete", { threadId });
        streamingByThreadRef.current.delete(threadId);
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        if (activeIdRef.current === threadId) {
          setActiveId(null);
          setMessages([]);
          setStreaming(null);
          setActiveTurn(null);
          setWork([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const removeProject = useCallback(async (projectId: string) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      await client.send("project.remove", { projectId });
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setThreads((prev) => {
        const open = prev.find((t) => t.id === activeIdRef.current);
        if (open?.projectId === projectId) {
          setActiveId(null);
          setMessages([]);
          setStreaming(null);
          setActiveTurn(null);
          setWork([]);
        }
        return prev.filter((t) => t.projectId !== projectId);
      });
      setLanes((prev) => prev.filter((l) => l.projectId !== projectId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unknown command/i.test(msg)) {
        setError(
          "Daemon is outdated and does not support removing projects. Quit Divisio, stop any process on port 4577, then reopen — or press ⌘R after restarting.",
        );
      } else {
        setError(msg);
      }
    }
  }, []);

  /**
   * Hands the thread to another provider. `log` skips asking the current CLI
   * for a note — required when that CLI has hit a usage limit.
   */
  const handoff = async (toProvider: string, packet?: "log") => {
    const client = clientRef.current;
    if (!client || !activeId) return null;
    if (activeTurn || threadRunning) {
      setError("Stop the running turn before handing off.");
      return null;
    }
    setHandoffBusy(true);
    setError(null);
    try {
      const res = await client.send("thread.handoff", {
        threadId: activeId,
        toProvider,
        ...(packet ? { packet } : {}),
      });
      await refresh(client);
      setView("thread");
      await openThread(res.thread.id);
      return res.thread;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(
        raw.includes("timed out")
          ? "Handoff timed out. Try again — or stop any running turn first."
          : raw,
      );
      return null;
    } finally {
      setHandoffBusy(false);
    }
  };

  const files = useFiles(clientRef, activeIdRef);
  const attention = useAttention(threads, activeId);

  /** Restores the tree to the state before a turn, then refreshes the diff. */
  const restoreTurn = useCallback(async (turnId: string) => {
    const client = clientRef.current;
    if (!client || !activeIdRef.current) return;
    setError(null);
    try {
      const result = await client.send("turn.restore", {
        threadId: activeIdRef.current,
        turnId,
        phase: "pre",
      });
      if (result.status !== "restored") {
        setError(result.detail ?? `restore ${result.status}`);
        return;
      }
      setChangesView(null);
      setDiffView(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const terminalApi = useMemo(
    () => ({
      open: async (cols: number, rows: number) => {
        const client = clientRef.current;
        if (!client || !activeIdRef.current) throw new Error("not connected");
        const res = await client.send("terminal.open", {
          threadId: activeIdRef.current,
          cols,
          rows,
        });
        return res.sessionId;
      },
      input: (sessionId: string, data: string) => {
        void clientRef.current?.send("terminal.input", { sessionId, data }).catch(() => undefined);
      },
      resize: (sessionId: string, cols: number, rows: number) => {
        void clientRef.current?.send("terminal.resize", { sessionId, cols, rows }).catch(() => undefined);
      },
      close: (sessionId: string) => {
        void clientRef.current?.send("terminal.close", { sessionId }).catch(() => undefined);
      },
      subscribe: (sessionId: string, onData: (d: string) => void, onExit: (c: number) => void) =>
        clientRef.current?.onTerminal(sessionId, { data: onData, exit: onExit }) ?? (() => {}),
    }),
    [],
  );

  const openSettings = useCallback((section: SettingsSection = "providers") => {
    setSettingsOpen(section);
  }, []);

  const reconnectDaemon = useCallback(() => {
    clientRef.current?.reconnect();
    if (isTauri()) {
      void (async () => {
        const next = await readDaemonToken();
        if (next && next !== tokenRef.current) setToken(next);
      })();
    }
  }, []);

  const loadSettingsToolchain = useCallback(async () => {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    return client.send("toolchain.status", {});
  }, []);

  const loadSettingsActivity = useCallback(async () => {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    return client.send("stats.activity", {});
  }, []);

  const loadSettingsUsage = useCallback(async (days: UsageRangeDays) => {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    return client.send("stats.usage", { days });
  }, []);

  const openPairing = async () => {
    const client = clientRef.current;
    if (!client) return;
    setPairing(await client.send("pairing.status", {}));
    openSettings("connections");
  };

  const ensurePairing = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setPairing(await client.send("pairing.status", {}));
  }, []);

  const refreshPairing = async () => {
    const client = clientRef.current;
    if (client) setPairing(await client.send("pairing.status", {}));
  };

  const dismissOnboarding = useCallback(() => {
    localStorage.setItem("divisio:onboarded", "1");
    setOnboardingDismissed(true);
    setForceOnboarding(false);
  }, []);

  const replayOnboarding = useCallback(() => {
    localStorage.removeItem("divisio:onboarded");
    setOnboardingDismissed(false);
    setForceOnboarding(true);
    setSettingsOpen(null);
  }, []);

  /** Creates the project, thread, and first turn as one action. */
  const startFirstThread = useCallback(
    async (projectId: string, providerKind: string, text: string) => {
      const client = clientRef.current;
      if (!client) throw new Error("not connected");
      await createAndSend({
        projectId,
        provider: providerKind,
        model: null,
        permissionMode: "supervised",
        text,
        images: [],
      });
      dismissOnboarding();
    },
    [createAndSend, dismissOnboarding],
  );

  const createProject = useCallback(async (name: string, rootPath: string) => {
    const client = clientRef.current;
    if (!client) return null;
    const res = await client.send("project.create", { name, rootPath });
    await refresh(client);
    return res.project;
  }, [refresh]);

  const previewUrl = useMemo(() => {
    if (!activeThread?.laneId) return "http://127.0.0.1:3000";
    const lane = lanes.find((l) => l.id === activeThread.laneId);
    return lane ? `http://127.0.0.1:${lane.port}` : "http://127.0.0.1:3000";
  }, [activeThread, lanes]);

  const paletteActions: PaletteAction[] = useMemo(() => {
    const acts: PaletteAction[] = [
      { id: "new", label: "New chat", group: "Chat", run: () => openNewThread() },
      { id: "add-project", label: "Add project…", group: "Project", run: () => setAddProjectOpen(true) },
      { id: "board", label: "Open board", group: "Navigate", run: () => { setSettingsOpen(null); setView("board"); } },
      { id: "providers", label: "Providers", group: "Navigate", run: () => openSettings("providers") },
      { id: "profile", label: "Profile", group: "Navigate", run: () => openSettings("profile") },
      { id: "usage", label: "Usage", group: "Navigate", run: () => openSettings("usage") },
      { id: "settings", label: "Settings", group: "Navigate", run: () => openSettings("providers") },
      {
        id: "devices",
        label: "Devices",
        group: "Navigate",
        run: () => {
          void openPairing();
        },
      },
      {
        id: "source-control",
        label: "Source Control settings",
        group: "Navigate",
        run: () => openSettings("sourceControl"),
      },
    ];
    if (activeThread) {
      acts.push(
        { id: "surf", label: "Open a surface…", group: "Surfaces", run: () => openSurface("picker") },
        { id: "changes", label: "Changes", group: "Surfaces", run: () => openSurface("changes") },
        { id: "files", label: "Files", group: "Surfaces", run: () => openSurface("files") },
        { id: "browser", label: "Browser", group: "Surfaces", run: () => openSurface("browser") },
        {
          id: "term-dock",
          label: terminalDock ? "Hide terminal" : "Show terminal",
          group: "Surfaces",
          run: () => setTerminalDock((v) => !v),
        },
      );
    }
    return acts;
  }, [activeThread, terminalDock, openSettings, openNewThread]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--left-w",
      sidebarCollapsed ? "0px" : `${leftWidth}px`,
    );
  }, [leftWidth, sidebarCollapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘R / Ctrl+R reloads the window UI only. The daemon stays up; this
      // client reconnects. Shells owned by the old socket close with it.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        reloadApp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // These hooks must stay above the early returns below. React matches hooks
  // by call order, so anything declared after a conditional `return` runs on
  // some renders and not others, and the counts stop lining up.
  const showThinking =
    turnBusy && !(streaming && streaming.text.length > 0) && work.length === 0;

  // Drop the optimistic bubble as soon as the server's own copy of that turn
  // arrives, matching on turnId rather than text so a re-send is not eaten.
  const messagesWithPending = useMemo<MessageView[]>(() => {
    if (pendingUserText === null) return messages;
    const echoed = activeTurn !== null && messages.some((m) => m.turnId === activeTurn && m.role === "user");
    if (echoed) return messages;
    return [
      ...messages,
      {
        turnId: activeTurn ?? "pending",
        role: "user" as const,
        text: pendingUserText,
        at: new Date().toISOString(),
      },
    ];
  }, [messages, pendingUserText, activeTurn]);

  // Rebuilt only when its inputs change. As a bare literal this produced fresh
  // object identities on every render, so the memoized transcript rows below
  // re-rendered on each streaming commit anyway.
  const bubbles = useMemo<Bubble[]>(() => [
    ...messagesWithPending.map((m) => ({
      kind: m.role as "user" | "assistant",
      text: m.text,
      key: `${m.turnId}:${m.role}`,
      turnId: m.turnId,
      ...(m.role === "assistant" && diffByTurn.has(m.turnId)
        ? { changedFiles: diffByTurn.get(m.turnId) }
        : {}),
    })),
    ...(work.length > 0 ? [{ kind: "work" as const, text: "", key: "work", work }] : []),
    ...(streaming && streaming.text.length > 0
      ? [{ kind: "streaming" as const, text: streaming.text, key: "streaming" }]
      : []),
    ...(showThinking
      ? [
          {
            kind: "thinking" as const,
            text: handoffBusy ? "Handing off…" : "Thinking…",
            key: "thinking",
          },
        ]
      : []),
  ], [messagesWithPending, diffByTurn, work, streaming, showThinking, handoffBusy]);

  // Stable identity: an inline arrow here would defeat the transcript's row
  // memoization on every render.
  const openChanges = useCallback((turnId: string, path?: string) => {
    // A named file opens in the editor with that turn's edits highlighted;
    // reviewing a change in its surrounding code is what people do next. With
    // no path there is nothing to point at, so show the turn's diff instead.
    if (path) openFileRef.current(turnId, path);
    else void showDiffRef.current(turnId);
  }, []);

  const openTurnDiff = useCallback((turnId: string) => {
    void showDiffRef.current(turnId);
  }, []);

  showDiffRef.current = showDiff;
  openFileRef.current = openChangedFile;

  if (pairingState === "pairing") {
    return (
      <div className="empty">
        <h1>Pairing this device…</h1>
        <p>Exchanging the one-time link for a key that belongs to this device.</p>
      </div>
    );
  }

  if (!token) {
    if (pairingState === "failed") {
      return (
        <div className="empty">
          <h1>Pairing failed</h1>
          <p>{bootError}</p>
        </div>
      );
    }
    if (isTauri()) {
      return (
        <div className="empty">
          <BrandMark size={56} />
          <h1>{bootError ? "Daemon unavailable" : "Starting Divisio…"}</h1>
          <p>
            {bootError ??
              "The desktop shell is starting the local daemon and connecting automatically."}
          </p>
        </div>
      );
    }
    return (
      <TokenGate
        onSubmit={(t) => {
          localStorage.setItem("divisio:token", t);
          setToken(t);
        }}
      />
    );
  }


  const showRight = view === "thread" && !!activeThread && rightSurface !== null;
  const inSettings = settingsOpen !== null;

  // Shown when there is genuinely nothing to return to, or when Settings
  // asks to replay the welcome checklist.
  if (state === "open" && (forceOnboarding || (!onboardingDismissed && projects.length === 0))) {
    return (
      <Onboarding
        providers={providers}
        projects={projects}
        detecting={providersLoading}
        onRefreshProviders={refreshProviders}
        onPickFolder={pickDirectory}
        onCreateProject={createProject}
        onStartThread={startFirstThread}
        onSkip={dismissOnboarding}
      />
    );
  }

  if (incompatible) {
    const have = incompatible.have == null ? "none" : String(incompatible.have);
    return (
      <div className="empty">
        <h1>The daemon is out of date</h1>
        <p>
          This app needs daemon generation {incompatible.need}; the process on port 4577 reports{" "}
          {have}.
        </p>
        <p>
          Usually an earlier <code>bun run dev:server</code> is still holding the port. Stop that
          process and reopen Divisio.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`shell${inSettings ? " shell-settings" : showRight ? " shell-right" : ""}${sidebarCollapsed ? " shell-sidebar-collapsed" : ""}`}
      data-nav={navOpen ? "open" : "closed"}
      style={{ ["--left-w" as string]: sidebarCollapsed ? "0px" : `${leftWidth}px` }}
    >
      {inSettings ? (
        <SettingsShell
          key={settingsOpen}
          providers={providers}
          providerUpdates={cliUpdates}
          pairing={pairing}
          connectionState={state}
          client={clientRef.current}
          initialSection={settingsOpen}
          onClose={() => setSettingsOpen(null)}
          onRefreshProviders={() => void refreshProviders()}
          onEnsurePairing={ensurePairing}
          onLoadToolchain={loadSettingsToolchain}
          onLoadActivity={loadSettingsActivity}
          onLoadUsage={loadSettingsUsage}
          onCreateToken={async () => {
            const client = clientRef.current;
            if (!client) throw new Error("not connected");
            return client.send("pairing.createToken", {});
          }}
          onRevoke={async (clientId) => {
            await clientRef.current?.send("pairing.revoke", { clientId });
            await refreshPairing();
          }}
          onRevokeAll={async () => {
            await clientRef.current?.send("pairing.revokeAll", {});
            await refreshPairing();
          }}
          onReplayWelcome={replayOnboarding}
          onReconnect={reconnectDaemon}
        />
      ) : (
        <>
      {view === "board" ? (
        <header className="topbar" data-tauri-drag-region>
          <TopbarLead
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onSearch={() => setPaletteOpen(true)}
            onNav={() => setNavOpen((v) => !v)}
          />
          <div className="crumb">
            <span className="crumb-thread">Board</span>
            <span className="crumb-sep">·</span>
            <span className="crumb-project">parallel lanes</span>
          </div>
        </header>
      ) : activeThread ? (
        <ThreadTopbar
          thread={activeThread}
          projectName={projects.find((p) => p.id === activeThread.projectId)?.name ?? "project"}
          providers={providers}
          rightSurface={rightSurface}
          terminalDock={terminalDock}
          busy={turnBusy}
          handoffBusy={handoffBusy}
          dirty={!!gitStatus?.dirty}
          workdir={
            activeThread.laneId
              ? (lanes.find((l) => l.id === activeThread.laneId)?.root ?? null)
              : (projects.find((p) => p.id === activeThread.projectId)?.rootPath ?? null)
          }
          onNav={() => setNavOpen((v) => !v)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onSearch={() => setPaletteOpen(true)}
          onSurface={(surface) => openSurface(surface)}
          onCloseSurface={closeRight}
          onToggleDock={() => setTerminalDock((v) => !v)}
          onHandoff={(kind) => void handoff(kind)}
          onHint={(msg) => setError(msg)}
          gitActions={
            gitStatus?.git ? (
              <GitActionsControl
                dirty={!!gitStatus.dirty}
                hasRemote={!!gitStatus.hasRemote}
                canPr={!!activeThread.laneId}
                busy={turnBusy}
                onCommit={(msg) => commitThread(msg)}
                onPush={pushThread}
                onOpenPr={activeThread.laneId ? openThreadPr : undefined}
              />
            ) : undefined
          }
        />
      ) : (
        <header className="topbar" data-tauri-drag-region>
          <TopbarLead
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onSearch={() => setPaletteOpen(true)}
            onNav={() => setNavOpen((v) => !v)}
          />
        </header>
      )}
      <Sidebar
        projects={projects}
        threads={threads}
        lanes={lanes}
        activeId={activeId}
        state={state}
        onOpen={(id) => {
          setView("thread");
          setNavOpen(false);
          void openThread(id);
        }}
        onNew={() => openNewThread()}
        onNewInProject={(id) => openNewThread(id)}
        onAddProject={() => setAddProjectOpen(true)}
        onProviders={() => openSettings("providers")}
        onSettings={() => openSettings("providers")}
        onConnection={() => openSettings("general")}
        onRetry={reconnectDaemon}
        onProfile={() => openSettings("profile")}
        onDevices={() => void openPairing()}
        onLanes={() => {
          setView("board");
          setNavOpen(false);
        }}
        onRenameThread={(id, title) => void renameThread(id, title)}
        onDeleteThread={(id) => void deleteThread(id)}
        onRemoveProject={(id) => void removeProject(id)}
        laneCount={lanes.filter((l) => l.status !== "archived").length}
        view={view}
        onResizeWidth={(w) => {
          setLeftWidth(clampLeft(w));
          saveWidth("left", clampLeft(w));
        }}
        width={leftWidth}
      />
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        {view === "board" ? (
          <SessionBoard
            lanes={lanes}
            projects={projects}
            threads={threads}
            busy={laneBusy}
            onCreate={createLane}
            onArchive={archiveLane}
            onDiff={(laneId) => void showLaneDiff(laneId)}
            onOpenPr={openLanePr}
            onOpenThread={(id) => {
              setView("thread");
              void openThread(id);
            }}
            onNewThread={(laneId) => {
              const projectId = lanes.find((l) => l.id === laneId)?.projectId ?? null;
              setLaneForNewThread(laneId);
              setThreadProjectId(projectId);
              setDialog(true);
            }}
          />
        ) : activeThread ? (
          <div className="thread-column">
            {messages.length === 0 && !streaming && !turnBusy ? (
              <div className="draft-stage">
                <BrandMark size={40} />
                <h1 className="draft-headline">What should we build?</h1>
                {error && <div className="banner">{error}</div>}
                <BranchStrip
                  envLabel={
                    activeThread.laneId
                      ? (lanes.find((l) => l.id === activeThread.laneId)?.title ?? "Lane")
                      : "Local"
                  }
                  branch={gitStatus?.branch ?? lanes.find((l) => l.id === activeThread.laneId)?.branch ?? null}
                  workdirHint={
                    activeThread.laneId
                      ? (lanes.find((l) => l.id === activeThread.laneId)?.root ?? null)
                      : (projects.find((p) => p.id === activeThread.projectId)?.rootPath ?? null)
                  }
                  dirty={!!gitStatus?.dirty}
                />
                <Composer
                  busy={turnBusy}
                  provider={activeThread.provider}
                  model={activeThread.model ?? null}
                  providers={providers}
                  catalogs={modelCatalogs}
                  permissionMode={activeThread.permissionMode ?? "supervised"}
                  hasHistory={false}
                  hero
                  onSend={(text, model, images) => void send(text, model, images)}
                  onInterrupt={interrupt}
                stopping={stopping}
                  onPermissionMode={(m) => void setPermissionMode(m)}
                  onAgentSelect={(next) => void setThreadAgent(next)}
                />
              </div>
            ) : (
              <>
                <div className="thread-body">
                  <Transcript
                    bubbles={bubbles}
                    onOpenChanges={openChanges}
                    onOpenDiff={openTurnDiff}
                  />
                  {error && looksLikeUsageLimit({ message: error }) && activeThread ? (
                    <UsageLimitBanner
                      message={error}
                      current={activeThread.provider}
                      providers={providers}
                      turnBusy={turnBusy}
                      handoffBusy={handoffBusy}
                      onHandoff={(kind) => void handoff(kind, "log")}
                    />
                  ) : (
                    error && <div className="banner">{error}</div>
                  )}
                  {pendingApproval && (
                    <ApprovalBar pending={pendingApproval} onRespond={(d) => void respondApproval(d)} />
                  )}
                </div>
                <BranchStrip
                  envLabel={
                    activeThread.laneId
                      ? (lanes.find((l) => l.id === activeThread.laneId)?.title ?? "Lane")
                      : "Local"
                  }
                  branch={gitStatus?.branch ?? lanes.find((l) => l.id === activeThread.laneId)?.branch ?? null}
                  workdirHint={
                    activeThread.laneId
                      ? (lanes.find((l) => l.id === activeThread.laneId)?.root ?? null)
                      : (projects.find((p) => p.id === activeThread.projectId)?.rootPath ?? null)
                  }
                  dirty={!!gitStatus?.dirty}
                />
                <Composer
                  busy={turnBusy}
                  provider={activeThread.provider}
                  model={activeThread.model ?? null}
                  providers={providers}
                  catalogs={modelCatalogs}
                  permissionMode={activeThread.permissionMode ?? "supervised"}
                  hasHistory={messages.length > 0}
                  vendorSessionId={activeThread.vendorSessionId}
                  onSend={(text, model, images) => void send(text, model, images)}
                  onInterrupt={interrupt}
                stopping={stopping}
                  onPermissionMode={(m) => void setPermissionMode(m)}
                  onAgentSelect={(next) => void setThreadAgent(next)}
                />
              </>
            )}
            {/* Terminal docks under the prompt. */}
            {terminalDock && (
              <Suspense fallback={<div className="terminal-dock terminal-loading">Starting terminal…</div>}>
                <div className="terminal-dock" style={{ height: terminalHeight }}>
                  <div
                    className="terminal-resize"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize terminal"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const startY = e.clientY;
                      const startH = terminalHeight;
                      const el = e.currentTarget;
                      el.setPointerCapture(e.pointerId);
                      const move = (ev: PointerEvent) => {
                        const next = clampTerminal(startH + (startY - ev.clientY));
                        setTerminalHeight(next);
                      };
                      const up = (ev: PointerEvent) => {
                        el.releasePointerCapture(ev.pointerId);
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        saveTerminalHeight(clampTerminal(startH + (startY - (ev as PointerEvent).clientY)));
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                  />
                  <div className="terminal-head">
                    <span className="section-label">Terminal</span>
                    <IconButton
                      label="Close terminal"
                      icon={<CloseIcon />}
                      size="sm"
                      onClick={() => setTerminalDock(false)}
                    />
                  </div>
                  <TerminalPane key={activeThread.id} dark={dark} {...terminalApi} />
                </div>
              </Suspense>
            )}
          </div>
        ) : projects.length === 0 ? (
          <div className="empty landing">
            <LandingEmpty onAddProject={() => setAddProjectOpen(true)} />
          </div>
        ) : (
          <div className="empty landing">
            <div className="landing-stage">
              <BrandMark size={44} />
              <div className="landing-copy">
                <h1 className="draft-headline">What should we build?</h1>
                <p className="draft-sub">Start a chat — agents run under your own CLI logins.</p>
              </div>
              {error && <div className="banner">{error}</div>}
              {!addProjectOpen && (
                <Composer
                  busy={landingBusy}
                  landing
                  provider={draftProvider}
                  model={draftModel}
                  providers={providers}
                  catalogs={modelCatalogs}
                  permissionMode={draftPermission}
                  hasHistory={false}
                  projectId={draftProjectId || projects[0]?.id}
                  projects={projects.map((p) => ({ id: p.id, name: p.name, root: p.rootPath }))}
                  onProjectChange={(id) => {
                    setDraftProjectId(id);
                    localStorage.setItem("divisio:draft-project", id);
                  }}
                  onSend={(text, model, images) => void sendFromLanding(text, model, images)}
                  onInterrupt={() => undefined}
                  onPermissionMode={setDraftPermission}
                  onAgentSelect={(next) => {
                    setDraftProvider(next.provider);
                    setDraftModel(next.model);
                    localStorage.setItem("divisio:draft-provider", next.provider);
                  }}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {showRight && activeThread && rightSurface && (
        <RightPanel
          surface={rightSurface}
          dirtyHint={!!gitStatus?.dirty || diffByTurn.size > 0}
          onClose={closeRight}
        >
          {rightSurface === "picker" && (
            <RightSurfacePicker
              hasDiffHint={diffByTurn.size > 0 || !!gitStatus?.dirty}
              onPick={openSurface}
            />
          )}
          {rightSurface === "changes" && (
            <ChangesPane
              scope={changesScope}
              turnId={changesView?.turnId ?? null}
              turnOptions={[...diffByTurn.keys()].map((id, i) => ({
                turnId: id,
                label: `Turn ${i + 1} (${id.slice(0, 8)})`,
              }))}
              files={changesView?.files ?? []}
              patch={changesView?.patch ?? null}
              status={changesView?.status ?? (changesBusy ? "loading" : "ready")}
              detail={changesView?.detail}
              busy={changesBusy}
              preferredPath={changesView?.preferredPath ?? null}
              branch={changesView?.branch ?? gitStatus?.branch ?? null}
              onScopeChange={(scope) => {
                setChangesScope(scope);
                if (scope === "working" || scope === "branch") {
                  void loadScopedDiff(scope);
                  return;
                }
                const latest = [...diffByTurn.keys()].at(-1);
                if (latest) void showDiff(latest);
              }}
              onTurnChange={(turnId) => void showDiff(turnId)}
              {...(changesScope === "turn" && changesView?.turnId?.startsWith("trn_")
                ? { onRestore: restoreTurn }
                : {})}
              onCommit={commitThread}
            />
          )}
          {rightSurface === "files" && (
            <Suspense
              fallback={
                <section className="file-pane">
                  <div className="empty">
                    <p>Loading the editor…</p>
                  </div>
                </section>
              }
            >
              <FilePane
                threadId={activeThread.id}
                dark={dark}
                listDir={files.listDir}
                readFile={files.readFile}
                writeFile={files.writeFile}
                onClose={closeRight}
                focus={fileFocus}
              />
            </Suspense>
          )}
          {rightSurface === "browser" && <BrowserPane suggestedUrl={previewUrl} onClose={closeRight} />}
        </RightPanel>
      )}
        </>
      )}

      <UpdateToast
        updates={cliUpdates}
        onReview={() => openSettings("providers")}
      />

      <AttentionToasts
        items={attention.items}
        onOpen={(id) => {
          setSettingsOpen(null);
          setView("thread");
          void openThread(id);
        }}
        onDismiss={attention.dismiss}
      />

      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={() => setPaletteOpen(false)}
        projects={projects}
        threads={threads}
        lanes={lanes}
        onOpenThread={(id) => {
          setView("thread");
          setSettingsOpen(null);
          void openThread(id);
        }}
      />

      {dialog && (
        <NewThreadDialog
          lockedProjectId={
            threadProjectId ??
            (laneForNewThread ? (lanes.find((l) => l.id === laneForNewThread)?.projectId ?? null) : null)
          }
          projects={projects}
          providers={providers}
          onCreate={createThread}
          onAddProject={() => setAddProjectOpen(true)}
          onClose={() => {
            setDialog(false);
            setLaneForNewThread(null);
            setThreadProjectId(null);
          }}
        />
      )}

      {addProjectOpen && (
        <AddProjectDialog
          onCreateLocal={createProject}
          onClone={cloneProject}
          onClose={() => setAddProjectOpen(false)}
          onAdded={(project) => openNewThread(project.id)}
        />
      )}

      {diffView && (
        <TurnDiff
          {...diffView}
          {...(diffView.turnId.startsWith("trn_") ? { onRestore: restoreTurn } : {})}
          onClose={() => setDiffView(null)}
        />
      )}

      <ConfirmHost />
    </div>
  );
}

function TokenGate({ onSubmit }: { onSubmit(token: string): void }) {
  const [value, setValue] = useState("");
  return (
    <div className="empty">
      <BrandMark size={56} />
      <h1>Connect to the daemon</h1>
      <p>
        Paste the token from <code>~/.divisio/userdata/auth-token</code>. Auth is required on loopback too —
        localhost is not a trust boundary.
      </p>
      <div className="dialog" style={{ maxWidth: 420 }}>
        <input
          autoFocus
          value={value}
          placeholder="auth token"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && onSubmit(value.trim())}
        />
        <div className="actions">
          <Button variant="primary" size="sm" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
            Connect
          </Button>
        </div>
      </div>
    </div>
  );
}
