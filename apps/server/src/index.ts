import { AdapterRegistry, loadCommunityAdapters } from "@divisio/adapters";
import { createAdapters as createCommunityAdapters } from "@divisio/community-adapters";
import { DEFAULT_PORT, ENV_PREFIX, PRODUCT_NAME, WS_SUBPROTOCOL } from "@divisio/shared/brand";
import { newId } from "@divisio/shared/ids";
import { logger } from "@divisio/shared/log";
import { dbPath, ensureUserDataDir, tokenPath } from "@divisio/shared/paths";
import { repairPath } from "@divisio/shared/path-env";
import { Auth } from "./auth.ts";
import { ORCHESTRATOR_COMMANDS, Orchestrator } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";
import { WsHub, type SocketData } from "./ws.ts";
import { TerminalManager, terminalsAvailable } from "./terminal/pty.ts";
import { newId as newTerminalId } from "@divisio/shared/ids";
import { PairingStore } from "./pairing/store.ts";
import { InsecureBindError, reachableAddresses, resolveNetwork, type NetworkConfig } from "./pairing/network.ts";
import { syncCustomAdapters } from "./syncCustomAdapters.ts";
import { dirname, join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { userDataDir } from "@divisio/shared/paths";

const log = logger("daemon");

const port = Number(process.env[`${ENV_PREFIX}_PORT`] ?? DEFAULT_PORT);
// The Vite dev server runs on a different origin and must be allowlisted
// explicitly rather than by loosening the Origin check.
const devOrigins = (
  process.env[`${ENV_PREFIX}_DEV_ORIGINS`] ??
  "http://localhost:5173,http://127.0.0.1:5173,http://tauri.localhost,https://tauri.localhost,tauri://localhost"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Before anything can spawn a provider. A GUI-launched app inherits launchd's
// PATH, which contains none of the directories agent CLIs install into.
await repairPath();

ensureUserDataDir();

// Bind policy first: refusing an unsafe bind must happen before anything opens
// a socket or a database.
let network: NetworkConfig;
try {
  network = await resolveNetwork();
} catch (err) {
  if (err instanceof InsecureBindError) {
    log.error(err.message);
    process.exit(1);
  }
  throw err;
}

const store = new EventStore(dbPath());
const pairing = new PairingStore(join(userDataDir(), "pairing.sqlite"));

const remote = network.hostname !== "127.0.0.1" && network.hostname !== "localhost";
const scheme = network.tls ? "https" : "http";
const wsScheme = network.tls ? "wss" : "ws";

const auth = new Auth({
  port,
  extraOrigins: [
    ...devOrigins,
    // A paired remote client loads the UI from the daemon itself.
    ...(remote ? [`${scheme}://${network.hostname}:${port}`, ...reachableAddresses().map((a) => `${scheme}://${a}:${port}`)] : []),
  ],
  verifyClientToken: (token) => pairing.verifySessionToken(token),
  allowedHosts: remote ? [network.hostname, ...reachableAddresses()] : [],
});
const registry = new AdapterRegistry();
// Reference community pack is statically imported so `bun build --compile`
// embeds it (dynamic import of a workspace package fails under /$bunfs).
for (const adapter of createCommunityAdapters()) {
  registry.register(adapter, { source: "community" });
}
// Optional extra modules: userdata/adapters.json + DIVISIO_ADAPTER_MODULES.
await loadCommunityAdapters({ registry, builtinModules: [] });
syncCustomAdapters(registry);
const hub = new WsHub(store, newId("env"));
const pairingControls = {
  status: () => ({
    remote,
    tls: !!network.tls,
    address: remote ? `${scheme}://${reachableAddresses()[0] ?? network.hostname}:${port}` : null,
    fingerprint: network.fingerprint,
    clients: pairing.listClients(),
  }),
  createToken: () => {
    const { token, expiresAt } = pairing.createPairingToken();
    const address = reachableAddresses()[0] ?? network.hostname;
    return {
      url: `${scheme}://${address}:${port}/#pair=${token}`,
      expiresAt: expiresAt.toISOString(),
      fingerprint: network.fingerprint,
    };
  },
  revoke: (clientId: string) => pairing.revokeClient(clientId),
  revokeAll: () => pairing.revokeAll(),
};

const orchestrator = new Orchestrator(store, registry, hub, pairingControls);
hub.attach(orchestrator);

// Advertised to clients so a version mismatch reports itself instead of
// surfacing as "unknown command" wherever the user happens to click.
hub.supportedCommands = [
  ...ORCHESTRATOR_COMMANDS,
  "session.resume",
  "terminal.open",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
];

/**
 * Terminals are owned by the socket that opened them, not by the thread, so
 * they are handled here rather than in the orchestrator: a shell is a live
 * attachment to one client, not shared state derived from the event log.
 */
const terminals = new TerminalManager({
  onData: (sessionId, data) => hub.terminalData(sessionId, data),
  onExit: (sessionId, exitCode) => hub.terminalExit(sessionId, exitCode),
});

hub.onSocketGone = (sessionId) => terminals.get(sessionId)?.kill();

hub.terminals = async (ws, cmd, payload) => {
  switch (cmd) {
    case "terminal.open": {
      const p = payload as { threadId: string; cols: number; rows: number };
      if (!terminalsAvailable()) {
        throw new Error("terminals are unavailable on this machine (need Bun ≥1.3.5 with PTY support)");
      }
      const thread = store.getThread(p.threadId);
      if (!thread) throw new Error(`no such thread: ${p.threadId}`);
      // Same working directory the agent uses, so the shell and the agent see
      // the same tree — a lane-bound thread gets its worktree.
      const cwd = orchestrator.workdirForThread(p.threadId);
      const sessionId = newTerminalId("ses");
      terminals.open(sessionId, p.threadId, cwd, p.cols, p.rows);
      ws.data.terminals.add(sessionId);
      return { sessionId };
    }
    case "terminal.input": {
      const p = payload as { sessionId: string; data: string };
      // Ownership check: a socket may only write to a shell it opened.
      if (!ws.data.terminals.has(p.sessionId)) throw new Error("unknown terminal session");
      terminals.get(p.sessionId)?.write(p.data);
      return {};
    }
    case "terminal.resize": {
      const p = payload as { sessionId: string; cols: number; rows: number };
      if (!ws.data.terminals.has(p.sessionId)) throw new Error("unknown terminal session");
      terminals.get(p.sessionId)?.resize(p.cols, p.rows);
      return {};
    }
    case "terminal.close": {
      const p = payload as { sessionId: string };
      if (!ws.data.terminals.has(p.sessionId)) throw new Error("unknown terminal session");
      terminals.get(p.sessionId)?.kill();
      ws.data.terminals.delete(p.sessionId);
      return {};
    }
    default:
      throw new Error(`unknown terminal command: ${cmd}`);
  }
};

const server = Bun.serve<SocketData>({
  port,
  // Explicit, and never a fallback: resolveNetwork throws rather than quietly
  // downgrading an unsafe request.
  hostname: network.hostname,
  ...(network.tls ? { tls: network.tls } : {}),

  fetch(req, srv) {
    const url = new URL(req.url);

    // Pairing exchange. Deliberately unauthenticated — possession of a valid,
    // unused, unexpired pairing token IS the authentication, and it is consumed
    // on first use.
    if (url.pathname === "/pair" && req.method === "POST") {
      return handlePair(req);
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        product: PRODUCT_NAME,
        seq: store.head(),
        protocol: WS_SUBPROTOCOL,
        commands: hub.supportedCommands,
      });
    }

    if (url.pathname === "/ws") {
      const reason = auth.check(req);
      if (reason) {
        log.warn("upgrade rejected", { reason, path: url.pathname });
        const status = reason === "bad_host" || reason === "bad_origin" ? 403 : reason === "bad_protocol" ? 400 : 401;
        // No detail in the body about which check failed.
        return new Response("forbidden", { status });
      }

      // Remember which paired client this socket belongs to, so revocation can
      // find and close it.
      const presented = req.headers.get("authorization")?.replace(/^Bearer /, "")
        ?? (req.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((v) => v.trim())
          .find((v) => v.startsWith("bearer."))
          ?.slice("bearer.".length);
      const paired = presented ? auth.clientFor(presented) : null;

      const ok = srv.upgrade(req, {
        data: {
          clientId: newId("ses"),
          pairedClientId: paired?.id ?? null,
          threads: new Set<string>(),
          pending: new Map(),
          timer: null,
          catchUp: false,
          terminals: new Set<string>(),
        } satisfies SocketData,
        // Do NOT set Sec-WebSocket-Protocol here. Bun echoes the negotiated
        // subprotocol itself; setting it too emits the header twice and strict
        // clients close with 1002 "mismatch client protocol".
        //
        // Bun selects the client's FIRST offer, so clients must list the
        // version subprotocol before `bearer.<token>` — otherwise the token
        // would be reflected back in a response header. Enforced below.
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    return serveWebUi(url);
  },

  websocket: {
    open(ws) {
      hub.open(ws, WS_SUBPROTOCOL);
    },
    async message(ws, message) {
      await hub.message(ws, typeof message === "string" ? message : new TextDecoder().decode(message));
    },
    close(ws) {
      hub.close(ws);
    },
  },
});

/**
 * Static hosting for the built web UI.
 *
 * A paired device opens the daemon's own address, so the daemon has to serve
 * the app — without this, a pairing link lands on a 404 and remote access is
 * unusable no matter how well the token exchange works.
 *
 * In dev the UI is served by Vite instead, and this returns a pointer there.
 */
const WEB_DIST = (() => {
  for (const candidate of [
    // Packaged: dist sits beside the daemon binary's resources.
    join(dirname(process.execPath), "..", "Resources", "web"),
    // Dev / source checkout.
    join(import.meta.dir, "..", "..", "web", "dist"),
  ]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
})();

async function serveWebUi(url: URL): Promise<Response> {
  if (!WEB_DIST) {
    return new Response(
      "The web UI is not built. Run `bun run build`, or use the Vite dev server.",
      { status: 404, headers: { "content-type": "text/plain" } },
    );
  }

  // Confine to the dist directory: this path comes from the network.
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(WEB_DIST, requested);
  if (!candidate.startsWith(WEB_DIST)) return new Response("forbidden", { status: 403 });

  const file = Bun.file(candidate);
  if (requested !== "/" && (await file.exists())) {
    return new Response(file);
  }
  // Single-page app: unknown paths fall back to the shell so the client router
  // (and the #pair fragment) still work.
  return new Response(Bun.file(join(WEB_DIST, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handlePair(req: Request): Promise<Response> {
  const host = req.headers.get("host");
  const bare = host?.replace(/:\d+$/, "") ?? "";
  const allowed = ["localhost", "127.0.0.1", "::1", "[::1]", network.hostname, ...reachableAddresses()];
  if (!allowed.includes(bare)) return new Response("forbidden", { status: 403 });

  let body: { token?: string; label?: string };
  try {
    body = (await req.json()) as { token?: string; label?: string };
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!body.token) return new Response("bad request", { status: 400 });

  const result = pairing.redeemPairingToken(body.token, body.label ?? "paired client");
  // One response for expired, reused, and unknown alike: distinguishing them
  // tells an attacker which guesses were close.
  if (!result) return new Response("pairing failed", { status: 401 });

  return Response.json({ clientId: result.clientId, token: result.token, protocol: WS_SUBPROTOCOL });
}

// Revoking must drop live sockets, not merely refuse the next connection.
pairing.onClientRevoked((clientId) => hub.disconnectClient(clientId));

auth.logStartup();
log.info(`${PRODUCT_NAME} daemon listening`, {
  url: `${scheme}://${network.hostname}:${server.port}`,
  tokenFile: tokenPath(),
  db: dbPath(),
  remote,
  tls: !!network.tls,
});

if (remote) {
  const { token, expiresAt } = pairing.createPairingToken();
  const address = reachableAddresses()[0] ?? network.hostname;
  // Printed once, to stdout, never into persistent analytics.
  log.info("remote access enabled — pair a device with this single-use link", {
    expiresAt: expiresAt.toISOString(),
    ...(network.fingerprint ? { certificateFingerprint: network.fingerprint } : {}),
  });
  console.log(`\n  ${scheme}://${address}:${port}/#pair=${token}`);
  if (network.fingerprint) {
    console.log(`  certificate fingerprint: ${network.fingerprint}`);
    console.log("  Verify this fingerprint on the device before trusting the connection.\n");
  } else {
    console.log("");
  }
}

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  terminals.closeAll();
  await orchestrator.shutdown();
  store.close();
  pairing.close();
  await server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
