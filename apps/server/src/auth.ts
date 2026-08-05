import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureUserDataDir, tokenPath } from "@divisio/shared/paths";
import { WS_SUBPROTOCOL } from "@divisio/shared/brand";
import { logger } from "@divisio/shared/log";

const log = logger("auth");

/**
 * Handshake enforcement. Implements docs/architecture/security.md.
 *
 * The premise for all of it: this daemon spawns shells. Anyone who can send it
 * an authenticated request has code execution as this user. Loopback is not a
 * trust boundary — WebSocket upgrades skip CORS preflight, so any page the user
 * visits can reach 127.0.0.1, and DNS rebinding defeats Origin checks that rely
 * on the browser alone.
 */

export type RejectReason =
  | "bad_host"
  | "bad_origin"
  | "bad_protocol"
  | "no_token"
  | "bad_token";

export interface AuthConfig {
  port: number;
  /** Extra origins to allow, e.g. the Vite dev server. */
  extraOrigins?: string[];
  /**
   * Inject a token instead of reading/creating the userdata file.
   * Used by tests so they never touch the developer's live `~/.divisio`.
   */
  token?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Token-bearing subprotocol entry, for browser clients that cannot set headers. */
export const BEARER_PROTO_PREFIX = "bearer.";

export class Auth {
  readonly token: string;
  private readonly tokenBuf: Buffer;
  private readonly allowedOrigins: Set<string>;
  private readonly port: number;

  constructor(cfg: AuthConfig) {
    this.port = cfg.port;
    this.token = cfg.token ?? loadOrCreateToken();
    this.tokenBuf = Buffer.from(this.token, "utf8");
    this.allowedOrigins = new Set([
      `http://localhost:${cfg.port}`,
      `http://127.0.0.1:${cfg.port}`,
      ...(cfg.extraOrigins ?? []),
    ]);
  }

  /**
   * Runs the five ordered checks. Each rejects before any state is allocated.
   * Returns null when the request may proceed.
   */
  check(req: Request): RejectReason | null {
    const url = new URL(req.url);

    // 1. Host allowlist — the DNS-rebinding guard. Does not depend on the
    //    browser behaving, which is the entire point.
    const host = req.headers.get("host");
    if (!host || !LOOPBACK_HOSTS.has(stripPort(host))) return "bad_host";

    // 2. Origin allowlist. A missing Origin is rejected too: browsers always
    //    send one, and non-browser clients are not granted an origin-free path.
    const origin = req.headers.get("origin");
    if (!origin || !this.allowedOrigins.has(origin)) return "bad_origin";

    // 3. Subprotocol. An unrecognized version is rejected, never downgraded.
    const offered = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // The version must come FIRST. Bun echoes the client's first offer back in
    // the response, so a client that leads with `bearer.<token>` would have its
    // token reflected into a response header. Rejecting is safer than silently
    // reordering, because the client would then be wrong about what it sent.
    if (offered[0] !== WS_SUBPROTOCOL) return "bad_protocol";

    // 4/5. Token — required on loopback too, and never read from the query
    // string, because URLs leak into logs, history, and Referer headers.
    if (url.searchParams.has("token")) return "no_token";

    // Browsers cannot set headers on a WebSocket handshake, so the token may
    // also arrive as a `bearer.<token>` subprotocol entry. That is still a
    // header, so it carries none of the leakage problems of a query string.
    const bearerProto = offered.find((p) => p.startsWith(BEARER_PROTO_PREFIX));
    const header = req.headers.get("authorization");
    const presented = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : bearerProto?.slice(BEARER_PROTO_PREFIX.length);

    if (!presented) return "no_token";
    if (!this.verify(presented)) return "bad_token";

    return null;
  }

  /** Timing-safe. A plain === leaks the token one byte at a time. */
  verify(candidate: string): boolean {
    const buf = Buffer.from(candidate, "utf8");
    if (buf.length !== this.tokenBuf.length) return false;
    return timingSafeEqual(buf, this.tokenBuf);
  }

  /** Never logs the token itself. */
  logStartup() {
    log.info("auth ready", { tokenFile: tokenPath(), origins: [...this.allowedOrigins] });
  }
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const i = host.lastIndexOf(":");
  return i === -1 ? host : host.slice(0, i);
}

/**
 * Reads the token, creating it on first run.
 * 0600 because this file grants shell execution on this machine.
 */
function loadOrCreateToken(): string {
  ensureUserDataDir();
  const path = tokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) {
      chmodSync(path, 0o600);
      return existing;
    }
    log.warn("token file too short, regenerating");
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}
