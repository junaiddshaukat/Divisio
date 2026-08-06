import { AdapterRegistry } from "@divisio/adapters";
import { DEFAULT_PORT, ENV_PREFIX, PRODUCT_NAME, WS_SUBPROTOCOL } from "@divisio/shared/brand";
import { newId } from "@divisio/shared/ids";
import { logger } from "@divisio/shared/log";
import { dbPath, ensureUserDataDir, tokenPath } from "@divisio/shared/paths";
import { repairPath } from "@divisio/shared/path-env";
import { Auth } from "./auth.ts";
import { Orchestrator } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";
import { WsHub, type SocketData } from "./ws.ts";

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
const store = new EventStore(dbPath());
const auth = new Auth({ port, extraOrigins: devOrigins });
const registry = new AdapterRegistry();
const hub = new WsHub(store, newId("env"));
const orchestrator = new Orchestrator(store, registry, hub);
hub.attach(orchestrator);

const server = Bun.serve<SocketData>({
  port,
  hostname: "127.0.0.1", // Explicit. Never falls back to 0.0.0.0.

  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, product: PRODUCT_NAME, seq: store.head() });
    }

    if (url.pathname === "/ws") {
      const reason = auth.check(req);
      if (reason) {
        log.warn("upgrade rejected", { reason, path: url.pathname });
        const status = reason === "bad_host" || reason === "bad_origin" ? 403 : reason === "bad_protocol" ? 400 : 401;
        // No detail in the body about which check failed.
        return new Response("forbidden", { status });
      }

      const ok = srv.upgrade(req, {
        data: {
          clientId: newId("ses"),
          threads: new Set<string>(),
          pending: new Map(),
          timer: null,
          catchUp: false,
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

    return new Response("not found", { status: 404 });
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

auth.logStartup();
log.info(`${PRODUCT_NAME} daemon listening`, {
  url: `http://127.0.0.1:${server.port}`,
  tokenFile: tokenPath(),
  db: dbPath(),
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  await orchestrator.shutdown();
  store.close();
  await server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
