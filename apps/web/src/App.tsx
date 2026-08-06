import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiffFileEntry,
  DomainEvent,
  LaneView,
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
import { LaneBoard } from "./components/LaneBoard.tsx";
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
  const [laneBoard, setLaneBoard] = useState(false);
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
    const res = await client.send("thread.create", { projectId, title, provider });
    setDialog(false);
    await refresh(client);
    await openThread(res.thread.id);
  };

  const createProject = async (name: string, rootPath: string) => {
    const client = clientRef.current;
    if (!client) return null;
    const res = await client.send("project.create", { name, rootPath });
    await refresh(client);
    return res.project;
  };

  if (!token) {
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

  return (
    <div className="shell">
      <Sidebar
        projects={projects}
        threads={threads}
        activeId={activeId}
        state={state}
        onOpen={(id) => void openThread(id)}
        onNew={() => setDialog(true)}
        onProviders={() => setMatrixOpen(true)}
        onLanes={() => setLaneBoard(true)}
        laneCount={lanes.filter((l) => l.status !== "archived").length}
      />
      <main className="main">
        <div className="topbar">
          {activeThread ? (
            <span className="crumb">
              {projects.find((p) => p.id === activeThread.projectId)?.name ?? "project"} /{" "}
              <strong>{activeThread.title}</strong>
            </span>
          ) : (
            <span className="crumb">No thread selected</span>
          )}
          {activeThread && (
            <span className="status">
              <span className={`dot ${activeThread.status}`} />
              {activeThread.status}
            </span>
          )}
        </div>

        {activeThread ? (
          <>
            <Transcript bubbles={bubbles} onShowDiff={(turnId) => void showDiff(turnId)} />
            {error && <div className="banner">{error}</div>}
            {pendingApproval && (
              <ApprovalBar pending={pendingApproval} onRespond={(d) => void respondApproval(d)} />
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
          projects={projects}
          providers={providers}
          onCreateProject={createProject}
          onCreate={createThread}
          onClose={() => setDialog(false)}
        />
      )}
      {laneBoard && (
        <LaneBoard
          lanes={lanes}
          projects={projects}
          threads={threads}
          busy={laneBusy}
          onCreate={createLane}
          onArchive={archiveLane}
          onDiff={(laneId) => void showLaneDiff(laneId)}
          onClose={() => setLaneBoard(false)}
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
