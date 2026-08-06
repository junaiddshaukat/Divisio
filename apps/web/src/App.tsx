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
  ThreadView,
} from "@divisio/contracts";
import { Client, type ConnectionState } from "./client.ts";
import { ApprovalBar, type PendingApproval } from "./components/ApprovalBar.tsx";
import { CapabilityMatrix } from "./components/CapabilityMatrix.tsx";
import { Composer } from "./components/Composer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript, type Bubble } from "./components/Transcript.tsx";
import { NewThreadDialog } from "./components/NewThreadDialog.tsx";
import { SessionBoard } from "./components/SessionBoard.tsx";
import { HandoffMenu } from "./components/HandoffMenu.tsx";
import { PairingPanel } from "./components/PairingPanel.tsx";

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<{ turnId: string; text: string } | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [lanes, setLanes] = useState<LaneView[]>([]);
  const [view, setView] = useState<"thread" | "board">("thread");
  /** Set when the new-thread dialog was opened from a lane card. */
  const [laneForNewThread, setLaneForNewThread] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [pairing, setPairing] = useState<PairingStatus | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Sidebar is an overlay below tablet width; this drives it. */
  const [navOpen, setNavOpen] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [laneBusy, setLaneBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [diffTurns, setDiffTurns] = useState<Set<string>>(new Set());
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

  const refreshProviders = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const r = await client.send("provider.detect", {});
    setProviders(r.providers);
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setActiveId(threadId);
    setStreaming(null);
    setTools([]);
    setError(null);
    setPendingApproval(null);
    setDiffTurns(new Set());
    client.subscribe([threadId]);
    const snap = await client.send("thread.snapshot", { threadId });
    setMessages(snap.messages);
    setThreads((prev) => prev.map((t) => (t.id === snap.thread.id ? snap.thread : t)));
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
            setTools([]);
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
          if (p["threadId"] === activeIdRef.current) setTools((t) => [...t, String(p["name"])]);
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
            setDiffTurns((prev) => new Set(prev).add(String(p["turnId"])));
          }
          break;
        case "session.status":
          setThreads((prev) =>
            prev.map((t) => (t.id === p["threadId"] ? { ...t, status: p["status"] as never } : t)),
          );
          if (p["status"] === "error" && p["threadId"] === activeIdRef.current) {
            setError(String(p["detail"] ?? "session error"));
          }
          break;
        case "thread.permission_mode_set":
          setThreads((prev) =>
            prev.map((t) =>
              t.id === p["threadId"] ? { ...t, permissionMode: p["mode"] as PermissionMode } : t,
            ),
          );
          break;
        case "project.created":
        case "thread.created":
          void (clientRef.current && refresh(clientRef.current));
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
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setDark(document.documentElement.classList.contains("dark"));
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (state !== "open") return;
    const client = clientRef.current;
    if (!client) return;
    void refresh(client);
    void refreshProviders();
  }, [state, refresh, refreshProviders]);

  const send = async (text: string) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setError(null);
    try {
      const res = await client.send("turn.send", { threadId: activeId, text });
      setActiveTurn(res.turnId);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const interrupt = async () => {
    const client = clientRef.current;
    if (!client || !activeId || !activeTurn) return;
    try {
      await client.send("turn.interrupt", { threadId: activeId, turnId: activeTurn });
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

  const showDiff = async (turnId: string) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    try {
      const res = await client.send("turn.diff", { threadId: activeId, turnId });
      setDiffView({
        turnId,
        files: res.files,
        patch: res.patch,
        status: res.status,
        detail: res.detail,
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
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
    await refresh(client);
    setView("thread");
    await openThread(res.thread.id);
  };

  /**
   * Hands the thread to another provider. Costs one turn on the source agent,
   * which writes the handover note — we have no model of our own.
   */
  const handoff = async (toProvider: string) => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    setHandoffBusy(true);
    setError(null);
    try {
      const res = await client.send("thread.handoff", { threadId: activeId, toProvider });
      await refresh(client);
      setView("thread");
      await openThread(res.thread.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setHandoffBusy(false);
    }
  };

  const listDir = useCallback(async (path: string): Promise<FileTreeEntry[]> => {
    const client = clientRef.current;
    if (!client || !activeIdRef.current) return [];
    return (await client.send("file.tree", { threadId: activeIdRef.current, path })).entries;
  }, []);

  const readFile = useCallback(async (path: string) => {
    const client = clientRef.current;
    if (!client || !activeIdRef.current) throw new Error("not connected");
    return client.send("file.read", { threadId: activeIdRef.current, path });
  }, []);

  const writeFileContent = useCallback(async (path: string, content: string) => {
    const client = clientRef.current;
    if (!client || !activeIdRef.current) throw new Error("not connected");
    await client.send("file.write", { threadId: activeIdRef.current, path, content });
  }, []);

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

  const openPairing = async () => {
    const client = clientRef.current;
    if (!client) return;
    setPairing(await client.send("pairing.status", {}));
  };

  const refreshPairing = async () => {
    const client = clientRef.current;
    if (client) setPairing(await client.send("pairing.status", {}));
  };

  const createProject = async (name: string, rootPath: string) => {
    const client = clientRef.current;
    if (!client) return null;
    const res = await client.send("project.create", { name, rootPath });
    await refresh(client);
    return res.project;
  };

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

  const bubbles: Bubble[] = [
    ...messages.map((m) => ({
      kind: m.role as "user" | "assistant",
      text: m.text,
      key: `${m.turnId}:${m.role}`,
      turnId: m.turnId,
      showDiff: m.role === "assistant" && diffTurns.has(m.turnId),
    })),
    ...(tools.length > 0 && activeTurn ? [{ kind: "tools" as const, text: tools.join(", "), key: "tools" }] : []),
    ...(streaming && streaming.text.length > 0
      ? [{ kind: "streaming" as const, text: streaming.text, key: "streaming" }]
      : []),
  ];

  const showFiles = view === "thread" && !!activeThread && filesOpen;

  return (
    <div className={`shell${showFiles ? " shell-files" : ""}`} data-nav={navOpen ? "open" : "closed"}>
      <Sidebar
        projects={projects}
        threads={threads}
        activeId={activeId}
        state={state}
        onOpen={(id) => {
          setView("thread");
          setNavOpen(false);
          void openThread(id);
        }}
        onNew={() => setDialog(true)}
        onProviders={() => setMatrixOpen(true)}
        onDevices={() => void openPairing()}
        onLanes={() => {
          setView("board");
          setNavOpen(false);
        }}
        laneCount={lanes.filter((l) => l.status !== "archived").length}
        view={view}
      />
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        <div className="topbar">
          <button className="icon nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">
            ☰
          </button>
          {view === "board" ? (
            <span className="crumb">
              <strong>Board</strong> — parallel lanes
            </span>
          ) : activeThread ? (
            <span className="crumb">
              {projects.find((p) => p.id === activeThread.projectId)?.name ?? "project"} /{" "}
              <strong>{activeThread.title}</strong>
            </span>
          ) : (
            <span className="crumb">No thread selected</span>
          )}
          {view === "thread" && activeThread && (
            <div className="topbar-actions">
              <button className="icon" aria-pressed={filesOpen} onClick={() => setFilesOpen((v) => !v)}>
                {filesOpen ? "Hide files" : "Files"}
              </button>
              <button
                className="icon"
                aria-pressed={terminalOpen}
                onClick={() => setTerminalOpen((v) => !v)}
              >
                Terminal
              </button>
              <HandoffMenu
                current={activeThread.provider}
                providers={providers}
                busy={handoffBusy || !!activeTurn}
                onHandoff={(kind) => void handoff(kind)}
              />
              <span className="status">
                <span className={`dot ${activeThread.status}`} />
                {activeThread.status}
              </span>
            </div>
          )}
        </div>

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
              setLaneForNewThread(laneId);
              setDialog(true);
            }}
          />
        ) : activeThread ? (
          <>
            <Transcript bubbles={bubbles} onShowDiff={(turnId) => void showDiff(turnId)} />
            {error && <div className="banner">{error}</div>}
            {pendingApproval && (
              <ApprovalBar pending={pendingApproval} onRespond={(d) => void respondApproval(d)} />
            )}
            {terminalOpen && (
              <Suspense fallback={<div className="terminal-dock terminal-loading">Starting terminal…</div>}>
                <div className="terminal-dock">
                  <div className="terminal-head">
                    <span className="section-label">Terminal</span>
                    <button className="icon" onClick={() => setTerminalOpen(false)} title="Close terminal">
                      ✕
                    </button>
                  </div>
                  {/* Keyed by thread: switching threads must not leave a shell
                      attached to the previous working directory. */}
                  <TerminalPane key={activeThread.id} dark={dark} {...terminalApi} />
                </div>
              </Suspense>
            )}
            <Composer
              busy={!!activeTurn}
              provider={activeThread.provider}
              providers={providers}
              permissionMode={activeThread.permissionMode ?? "supervised"}
              onSend={send}
              onInterrupt={interrupt}
              onPermissionMode={(m) => void setPermissionMode(m)}
            />
          </>
        ) : (
          <div className="empty">
            <h1>What should we build?</h1>
            <p>
              Divisio drives the coding agents you already pay for. Add a project directory, start a thread, and
              the agent runs under your own CLI login.
            </p>
            <button className="btn" onClick={() => setDialog(true)}>
              New thread
            </button>
          </div>
        )}
      </main>

      {dialog && (
        <NewThreadDialog
          lockedProjectId={
            laneForNewThread ? (lanes.find((l) => l.id === laneForNewThread)?.projectId ?? null) : null
          }
          projects={projects}
          providers={providers}
          onCreateProject={createProject}
          onCreate={createThread}
          onClose={() => {
            setDialog(false);
            setLaneForNewThread(null);
          }}
        />
      )}
      {showFiles && activeThread && (
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
            listDir={listDir}
            readFile={readFile}
            writeFile={writeFileContent}
            onClose={() => setFilesOpen(false)}
          />
        </Suspense>
      )}

      {pairing && (
        <PairingPanel
          status={pairing}
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
          onClose={() => setPairing(null)}
        />
      )}

      {matrixOpen && (
        <CapabilityMatrix
          providers={providers}
          onClose={() => setMatrixOpen(false)}
          onRefresh={() => void refreshProviders()}
        />
      )}
      {diffView && (
        <TurnDiff
          {...diffView}
          {...(diffView.turnId.startsWith("trn_") ? { onRestore: restoreTurn } : {})}
          onClose={() => setDiffView(null)}
        />
      )}
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
          <button className="btn" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
