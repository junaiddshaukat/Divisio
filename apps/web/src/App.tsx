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
  ModelCatalog,
  ThreadView,
  DaemonIncompatibility,
} from "@divisio/contracts";
import { Client, type ConnectionState } from "./client.ts";
import { useFiles } from "./hooks/useFiles.ts";
import { useAttention } from "./hooks/useAttention.ts";
import { AttentionToasts } from "./components/AttentionToasts.tsx";
import { Onboarding } from "./components/onboarding/Onboarding.tsx";
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
import { ThreadTopbar } from "./components/ThreadTopbar.tsx";
import { Button, IconButton } from "./components/ui/Button.tsx";
import { CloseIcon, MenuIcon, SearchIcon, SidebarShowIcon } from "./components/ui/icons.ts";
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

const PORT = 4577;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readTokenSync(): string {
  const fromEnv = import.meta.env["VITE_DIVISIO_TOKEN"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return localStorage.getItem("divisio:token") ?? "";
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

async function readTokenAsync(): Promise<string> {
  const sync = readTokenSync();
  if (sync) return sync;
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
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ModelCatalog>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<{ turnId: string; text: string } | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
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
  /** Desktop collapse — persists across sessions. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("divisio:sidebar-collapsed") === "1",
  );
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
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const activeThread = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);
  const threadRunning =
    activeThread?.status === "running" ||
    activeThread?.status === "stopping" ||
    activeThread?.status === "awaiting_approval";
  /** Stop / disable send — status can lag behind events, so OR both signals. */
  const turnBusy = !!activeTurn || threadRunning || handoffBusy;

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
    setStreaming(null);
    setWork([]);
    setActiveTurn(null);
    setError(null);
    setPendingApproval(null);
    setDiffByTurn(new Map());
    setChangesView(null);
    setGitStatus(null);
    client.subscribe([threadId]);
    const snap = await client.send("thread.snapshot", { threadId });
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
          if (p["threadId"] !== activeIdRef.current) break;
          const msg: MessageView = {
            turnId: String(p["turnId"]),
            role: p["role"] as "user" | "assistant",
            text: String(p["text"]),
            at: event.at,
          };
          setMessages((prev) =>
            prev.some((m) => m.turnId === msg.turnId && m.role === msg.role) ? prev : [...prev, msg],
          );
          if (msg.role === "assistant") setStreaming(null);
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
          if (p["threadId"] === activeIdRef.current) {
            setActiveTurn(null);
            setStreaming(null);
            setPendingApproval(null);
          }
          break;
        case "turn.failed":
          if (p["threadId"] === activeIdRef.current) {
            setActiveTurn(null);
            setStreaming(null);
            setPendingApproval(null);
            setError(String(p["message"]));
          }
          break;
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
          if (p["threadId"] === activeIdRef.current) {
            const status = String(p["status"]);
            if (status === "error") {
              setError(String(p["detail"] ?? "session error"));
            }
            // Idle statuses without a matching turn.completed still clear the Stop button.
            if (
              status === "ready" ||
              status === "closed" ||
              status === "connecting" ||
              status === "error"
            ) {
              setActiveTurn(null);
              setStreaming(null);
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
        case "project.created":
        case "project.removed":
        case "thread.created":
        case "thread.renamed":
        case "thread.deleted":
          void (clientRef.current && refresh(clientRef.current));
          if (event.type === "thread.deleted" && p["threadId"] === activeIdRef.current) {
            setActiveId(null);
            setMessages([]);
            setStreaming(null);
            setActiveTurn(null);
            setWork([]);
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
  useEffect(() => {
    if (token || !isTauri()) return;
    let cancelled = false;
    const boot = async () => {
      for (let i = 0; i < 40; i++) {
        const next = await readTokenAsync();
        if (cancelled) return;
        if (next) {
          setToken(next);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!cancelled) {
        setBootError(
          "Could not reach the Divisio daemon. Is Bun installed and on PATH? Check the terminal for [daemon] logs.",
        );
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const client = new Client(WS_URL, token, {
      onEvent,
      onDelta: (threadId, turnId, text) => {
        if (threadId !== activeIdRef.current) return;
        setStreaming((prev) =>
          prev?.turnId === turnId ? { turnId, text: prev.text + text } : { turnId, text },
        );
      },
      onIncompatible: setIncompatible,
      onState: setState,
      onResync: () => {
        const id = activeIdRef.current;
        void refresh(client);
        if (id) void openThread(id);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [token, onEvent, refresh, openThread]);

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

  const send = async (
    text: string,
    model: string | null,
    images: Array<{ name: string; mimeType: string; dataBase64: string }> = [],
  ) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setError(null);
    try {
      const res = await client.send("turn.send", {
        threadId: activeId,
        text,
        ...(model ? { model } : {}),
        ...(images.length ? { images } : {}),
      });
      setActiveTurn(res.turnId);
    } catch (err) {
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
    try {
      await client.send("turn.interrupt", { threadId: activeId, turnId });
    } catch (err) {
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

  const setSidebarHidden = useCallback((hidden: boolean) => {
    localStorage.setItem("divisio:sidebar-collapsed", hidden ? "1" : "0");
    setSidebarCollapsed(hidden);
  }, []);

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
   * Hands the thread to another provider. Costs one turn on the source agent,
   * which writes the handover note — we have no model of our own.
   */
  const handoff = async (toProvider: string) => {
    const client = clientRef.current;
    if (!client || !activeId) return null;
    if (activeTurn || threadRunning) {
      setError("Stop the running turn before handing off.");
      return null;
    }
    setHandoffBusy(true);
    setError(null);
    try {
      const res = await client.send("thread.handoff", { threadId: activeId, toProvider });
      await refresh(client);
      setView("thread");
      await openThread(res.thread.id);
      return res.thread;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(
        raw.includes("timed out")
          ? "Handoff timed out while the source agent was writing the note. Try again — or stop any running turn first."
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
      const res = await client.send("thread.create", {
        projectId,
        title: text.length > 48 ? `${text.slice(0, 48)}…` : text,
        provider: providerKind,
      });
      dismissOnboarding();
      await refresh(client);
      setView("thread");
      await openThread(res.thread.id);
      await client.send("turn.send", { threadId: res.thread.id, text });
    },
    [dismissOnboarding, refresh, openThread],
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
      // ⌘R / Ctrl+R — reload the window (devtools often disable this by default).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        reloadApp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const showThinking =
    turnBusy && !(streaming && streaming.text.length > 0) && work.length === 0;

  const bubbles: Bubble[] = [
    ...messages.map((m) => ({
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
            text: handoffBusy ? "Writing handover…" : "Thinking…",
            key: "thinking",
          },
        ]
      : []),
  ];

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
          pairing={pairing}
          connectionState={state}
          client={clientRef.current}
          initialSection={settingsOpen}
          onClose={() => setSettingsOpen(null)}
          onRefreshProviders={() => void refreshProviders()}
          onEnsurePairing={ensurePairing}
          onLoadToolchain={async () => {
            const client = clientRef.current;
            if (!client) throw new Error("not connected");
            return client.send("toolchain.status", {});
          }}
          onLoadActivity={async () => {
            const client = clientRef.current;
            if (!client) throw new Error("not connected");
            return client.send("stats.activity", {});
          }}
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
        />
      ) : (
        <>
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
        onProfile={() => openSettings("profile")}
        onDevices={() => void openPairing()}
        onSearch={() => setPaletteOpen(true)}
        onLanes={() => {
          setView("board");
          setNavOpen(false);
        }}
        onHideSidebar={() => setSidebarHidden(true)}
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
      {sidebarCollapsed && (
        <div className="sidebar-rail" role="toolbar" aria-label="Sidebar">
          <IconButton
            label="Show sidebar"
            icon={<SidebarShowIcon />}
            size="sm"
            onClick={() => setSidebarHidden(false)}
          />
          <IconButton
            label="Search (⌘K)"
            icon={<SearchIcon />}
            size="sm"
            onClick={() => setPaletteOpen(true)}
          />
        </div>
      )}
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        {view === "board" ? (
          <header className="topbar">
            <IconButton
              label="Menu"
              icon={<MenuIcon />}
              size="sm"
              className="nav-toggle"
              onClick={() => setNavOpen((v) => !v)}
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
          <header className="topbar topbar-landing">
            <IconButton
              label="Menu"
              icon={<MenuIcon />}
              size="sm"
              className="nav-toggle"
              onClick={() => setNavOpen((v) => !v)}
            />
          </header>
        )}


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
              <div className="draft-stack">
                <div className="draft-spacer" aria-hidden />
                <div className="draft-hero">
                  <h1 className="draft-headline">What should we build?</h1>
                </div>
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
                  onPermissionMode={(m) => void setPermissionMode(m)}
                  onAgentSelect={(next) => void setThreadAgent(next)}
                />
              </div>
            ) : (
              <>
                <div className="thread-body">
                  <Transcript
                    bubbles={bubbles}
                    onOpenChanges={(turnId, path) => void showDiff(turnId, path)}
                  />
                  {error && <div className="banner">{error}</div>}
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
        ) : (
          <div className="empty landing">
            <div className="draft-stack">
              <div className="draft-spacer" aria-hidden />
              <div className="draft-hero">
                <h1 className="draft-headline">What should we build?</h1>
                <p className="draft-sub">Start a chat — agents run under your own CLI logins.</p>
              </div>
              {error && <div className="banner">{error}</div>}
              <div className="composer-wrap composer-hero">
                <button
                  type="button"
                  className="landing-composer"
                  aria-label="Start a new chat"
                  onClick={() => openNewThread()}
                >
                  <span className="landing-composer-placeholder">Do anything.</span>
                  <span className="landing-composer-bar">
                    <span className="landing-composer-send" aria-hidden />
                  </span>
                </button>
              </div>
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
              />
            </Suspense>
          )}
          {rightSurface === "browser" && <BrowserPane suggestedUrl={previewUrl} onClose={closeRight} />}
        </RightPanel>
      )}
        </>
      )}

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
