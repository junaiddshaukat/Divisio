import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DomainEvent, MessageView, ProjectView, ProviderView, ThreadView } from "@divisio/contracts";
import { Client, type ConnectionState } from "./client.ts";
import { Composer } from "./components/Composer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript, type Bubble } from "./components/Transcript.tsx";
import { NewThreadDialog } from "./components/NewThreadDialog.tsx";

const PORT = 4577;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

/**
 * The token is read from a dev-time env var or a prompt. It is never placed in
 * the URL, so it does not end up in history, logs, or a Referer header.
 */
function readToken(): string {
  const fromEnv = import.meta.env["VITE_DIVISIO_TOKEN"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return localStorage.getItem("divisio:token") ?? "";
}

export function App() {
  const [token, setToken] = useState(readToken);
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

  const clientRef = useRef<Client | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const activeThread = useMemo(() => threads.find((t) => t.id === activeId) ?? null, [threads, activeId]);

  const refresh = useCallback(async (client: Client) => {
    const list = await client.send("project.list", {});
    setProjects(list.projects);
    setThreads(list.threads);
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    const client = clientRef.current;
    if (!client) return;
    setActiveId(threadId);
    setStreaming(null);
    setTools([]);
    setError(null);
    client.subscribe([threadId]);
    const snap = await client.send("thread.snapshot", { threadId });
    setMessages(snap.messages);
    setThreads((prev) => prev.map((t) => (t.id === snap.thread.id ? snap.thread : t)));
  }, []);

  /** Applies one domain event to local projections. Clients render, never invent. */
  const onEvent = useCallback((event: DomainEvent) => {
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
        // The durable message supersedes the streamed preview.
        if (msg.role === "assistant") setStreaming(null);
        break;
      }
      case "turn.started":
        if (p["threadId"] === activeIdRef.current) {
          setActiveTurn(String(p["turnId"]));
          setTools([]);
        }
        break;
      case "turn.completed":
      case "turn.interrupted":
        if (p["threadId"] === activeIdRef.current) {
          setActiveTurn(null);
          setStreaming(null);
        }
        break;
      case "turn.failed":
        if (p["threadId"] === activeIdRef.current) {
          setActiveTurn(null);
          setStreaming(null);
          setError(String(p["message"]));
        }
        break;
      case "tool.started":
        if (p["threadId"] === activeIdRef.current) setTools((t) => [...t, String(p["name"])]);
        break;
      case "session.status":
        setThreads((prev) =>
          prev.map((t) => (t.id === p["threadId"] ? { ...t, status: p["status"] as never } : t)),
        );
        if (p["status"] === "error" && p["threadId"] === activeIdRef.current) {
          setError(String(p["detail"] ?? "session error"));
        }
        break;
      case "project.created":
      case "thread.created":
        void (clientRef.current && refresh(clientRef.current));
        break;
    }
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    const client = new Client(WS_URL, token, {
      onEvent,
      onDelta: (threadId, turnId, text) => {
        if (threadId !== activeIdRef.current) return;
        setStreaming((prev) => (prev?.turnId === turnId ? { turnId, text: prev.text + text } : { turnId, text }));
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
    void client.send("provider.detect", {}).then((r) => setProviders(r.providers));
  }, [state, refresh]);

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

  if (!token) return <TokenGate onSubmit={(t) => { localStorage.setItem("divisio:token", t); setToken(t); }} />;

  const bubbles: Bubble[] = [
    ...messages.map((m) => ({ kind: m.role, text: m.text, key: `${m.turnId}:${m.role}` })),
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
            <Transcript bubbles={bubbles} />
            {error && <div className="banner">{error}</div>}
            <Composer
              busy={!!activeTurn}
              provider={activeThread.provider}
              providers={providers}
              onSend={send}
              onInterrupt={interrupt}
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
