import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { logger } from "@divisio/shared/log";

const log = logger("pairing");

/**
 * Pairing and session tokens.
 *
 * Deliberately not part of the event log. Events are permanent and replayable;
 * a credential must be revocable and forgettable, and docs/architecture/security.md
 * forbids secrets in event payloads.
 *
 * Only hashes are stored. A token grants shell execution on this machine, so a
 * leaked database must not be equivalent to a leaked credential. The tokens are
 * 256 bits of CSPRNG output, so a plain SHA-256 is enough — there is nothing to
 * brute force and no need for a slow KDF.
 */

/** Pairing tokens expire quickly whether or not they are used. */
const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface ClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class PairingStore {
  private readonly db: Database;
  /** Called when a client is revoked, so live sockets close rather than linger. */
  private onRevoke: ((clientId: string) => void) | null = null;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec(`
      create table if not exists pairing_tokens (
        token_hash text primary key,
        created_at text not null,
        expires_at text not null,
        used_at    text
      );
      create table if not exists clients (
        id           text primary key,
        token_hash   text not null unique,
        label        text not null,
        created_at   text not null,
        last_seen_at text,
        revoked_at   text
      );
    `);
  }

  onClientRevoked(handler: (clientId: string) => void) {
    this.onRevoke = handler;
  }

  /**
   * Mints a single-use pairing token.
   * Returned in clear exactly once; only its hash is retained.
   */
  createPairingToken(): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    this.db
      .query("insert into pairing_tokens (token_hash, created_at, expires_at) values (?, ?, ?)")
      .run(hash(token), now.toISOString(), expiresAt.toISOString());
    this.pruneExpired();
    return { token, expiresAt };
  }

  /**
   * Exchanges a pairing token for a durable session token.
   *
   * The pairing token is consumed inside the same transaction that issues the
   * session token, so two clients racing the same pairing URL cannot both pair.
   */
  redeemPairingToken(pairingToken: string, label: string): { clientId: string; token: string } | null {
    const tokenHash = hash(pairingToken);
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      const row = this.db
        .query<{ token_hash: string; expires_at: string; used_at: string | null }, [string]>(
          "select token_hash, expires_at, used_at from pairing_tokens where token_hash = ?",
        )
        .get(tokenHash);

      if (!row) return null;
      if (row.used_at) {
        log.warn("pairing token reuse refused");
        return null;
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        log.warn("pairing token expired");
        return null;
      }

      this.db.query("update pairing_tokens set used_at = ? where token_hash = ?").run(now, tokenHash);

      const clientId = `cli_${randomBytes(8).toString("hex")}`;
      const sessionToken = randomBytes(32).toString("base64url");
      this.db
        .query("insert into clients (id, token_hash, label, created_at) values (?, ?, ?, ?)")
        .run(clientId, hash(sessionToken), label.slice(0, 60) || "paired client", now);

      return { clientId, token: sessionToken };
    });

    const result = run();
    if (result) log.info("client paired", { clientId: result.clientId, label });
    return result;
  }

  /** Resolves a session token to a live client, or null when revoked or unknown. */
  verifySessionToken(token: string): ClientRecord | null {
    const row = this.db
      .query<
        {
          id: string;
          token_hash: string;
          label: string;
          created_at: string;
          last_seen_at: string | null;
          revoked_at: string | null;
        },
        [string]
      >("select * from clients where token_hash = ?")
      .get(hash(token));

    if (!row || row.revoked_at) return null;
    // Re-check in constant time: the lookup above is a hash equality test, and
    // keeping the comparison uniform avoids leaking through timing here too.
    if (!constantTimeEqual(row.token_hash, hash(token))) return null;

    this.db.query("update clients set last_seen_at = ? where id = ?").run(new Date().toISOString(), row.id);
    return {
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  listClients(): ClientRecord[] {
    return this.db
      .query<
        { id: string; label: string; created_at: string; last_seen_at: string | null },
        []
      >("select id, label, created_at, last_seen_at from clients where revoked_at is null order by created_at")
      .all()
      .map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  /** Revoking must also drop live sockets, not merely refuse the next connection. */
  revokeClient(clientId: string): boolean {
    const result = this.db
      .query("update clients set revoked_at = ? where id = ? and revoked_at is null")
      .run(new Date().toISOString(), clientId);
    const revoked = result.changes > 0;
    if (revoked) {
      log.info("client revoked", { clientId });
      this.onRevoke?.(clientId);
    }
    return revoked;
  }

  revokeAll(): number {
    const ids = this.listClients().map((c) => c.id);
    for (const id of ids) this.revokeClient(id);
    return ids.length;
  }

  private pruneExpired() {
    this.db.query("delete from pairing_tokens where expires_at < ?").run(new Date().toISOString());
  }

  close() {
    this.db.close();
  }
}
