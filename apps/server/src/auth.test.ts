import { describe, expect, test } from "bun:test";
import { WS_SUBPROTOCOL } from "@divisio/shared/brand";
import { Auth, BEARER_PROTO_PREFIX, type RejectReason } from "./auth.ts";

/**
 * The five handshake checks × the concrete rejection paths Phase 0 verified by hand.
 * Spec: docs/architecture/security.md + docs/architecture/ws-protocol.md
 */
const PORT = 4577;
const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function auth() {
  return new Auth({
    port: PORT,
    token: TOKEN,
    extraOrigins: [`http://localhost:5173`],
  });
}

function upgrade(init: {
  host?: string | null;
  origin?: string | null;
  protocol?: string | null;
  authorization?: string | null;
  url?: string;
}): { reason: RejectReason | null; statusHint: number } {
  const headers = new Headers();
  if (init.host !== null && init.host !== undefined) headers.set("host", init.host);
  if (init.origin !== null && init.origin !== undefined) headers.set("origin", init.origin);
  if (init.protocol !== null && init.protocol !== undefined) {
    headers.set("sec-websocket-protocol", init.protocol);
  }
  if (init.authorization !== null && init.authorization !== undefined) {
    headers.set("authorization", init.authorization);
  }
  const req = new Request(init.url ?? `http://127.0.0.1:${PORT}/ws`, { headers });
  const reason = auth().check(req);
  const statusHint =
    reason === "bad_host" || reason === "bad_origin"
      ? 403
      : reason === "bad_protocol"
        ? 400
        : reason
          ? 401
          : 101;
  return { reason, statusHint };
}

describe("handshake rejections (8 paths)", () => {
  test("1. rebinding Host → bad_host (403)", () => {
    const { reason, statusHint } = upgrade({
      host: "evil.example:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reason).toBe("bad_host");
    expect(statusHint).toBe(403);
  });

  test("2. foreign Origin → bad_origin (403)", () => {
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: "https://evil.example",
      protocol: WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reason).toBe("bad_origin");
    expect(statusHint).toBe(403);
  });

  test("3. missing Origin → bad_origin (403)", () => {
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: null,
      protocol: WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reason).toBe("bad_origin");
    expect(statusHint).toBe(403);
  });

  test("4. unknown subprotocol → bad_protocol (400)", () => {
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: "orchestrator.v1",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reason).toBe("bad_protocol");
    expect(statusHint).toBe(400);
  });

  test("5. bearer token offered FIRST → bad_protocol (400)", () => {
    // Bun would echo the first offer; leading with bearer would leak the token.
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: `${BEARER_PROTO_PREFIX}${TOKEN}, ${WS_SUBPROTOCOL}`,
      authorization: null,
    });
    expect(reason).toBe("bad_protocol");
    expect(statusHint).toBe(400);
  });

  test("6. no token on loopback → no_token (401)", () => {
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: WS_SUBPROTOCOL,
      authorization: null,
    });
    expect(reason).toBe("no_token");
    expect(statusHint).toBe(401);
  });

  test("7. token in query string → no_token (401)", () => {
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
      url: `http://127.0.0.1:${PORT}/ws?token=${TOKEN}`,
    });
    expect(reason).toBe("no_token");
    expect(statusHint).toBe(401);
  });

  test("8. wrong bearer token → bad_token (401)", () => {
    const { reason, statusHint } = upgrade({
      host: "127.0.0.1:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: WS_SUBPROTOCOL,
      authorization: "Bearer totally-wrong-token-bbbbbbbbbbbbbbbbbbbb",
    });
    expect(reason).toBe("bad_token");
    expect(statusHint).toBe(401);
  });
});

describe("handshake success", () => {
  test("Authorization header accepted", () => {
    const { reason } = upgrade({
      host: "localhost:4577",
      origin: `http://localhost:${PORT}`,
      protocol: WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reason).toBeNull();
  });

  test("version-first + bearer subprotocol accepted (browser path)", () => {
    const { reason } = upgrade({
      host: "127.0.0.1:4577",
      origin: `http://127.0.0.1:${PORT}`,
      protocol: `${WS_SUBPROTOCOL}, ${BEARER_PROTO_PREFIX}${TOKEN}`,
      authorization: null,
    });
    expect(reason).toBeNull();
  });

  test("Vite extra origin accepted", () => {
    const { reason } = upgrade({
      host: "127.0.0.1:4577",
      origin: "http://localhost:5173",
      protocol: WS_SUBPROTOCOL,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reason).toBeNull();
  });
});
