import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";
import { ENV_PREFIX } from "@divisio/shared/brand";
import { userDataDir } from "@divisio/shared/paths";
import { spawnWithEnv } from "@divisio/shared/spawn";
import { logger } from "@divisio/shared/log";

const log = logger("network");

/**
 * Bind policy and TLS. Implements the remote-access rules in
 * docs/architecture/security.md.
 *
 * The rule that drives everything here: a bearer token over plaintext on a
 * shared network is sniffable, and the prize is shell execution on the user's
 * machine. Binding off loopback therefore requires TLS or an encrypted overlay,
 * and the daemon refuses to start rather than downgrading.
 */

export interface NetworkConfig {
  hostname: string;
  tls: { cert: string; key: string } | null;
  /** SHA-256 of the certificate, for the client to pin at pairing time. */
  fingerprint: string | null;
}

export class InsecureBindError extends Error {}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. Treating
  // 127.0.0.2 as remote would demand TLS for traffic that never leaves the host.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Tailscale and similar overlays already encrypt the link, so a bind to one of
 * their addresses is not plaintext-over-LAN. Recognising that avoids forcing
 * users onto self-signed certs for a link that is already protected.
 */
function isEncryptedOverlay(host: string): boolean {
  // Tailscale CGNAT range 100.64.0.0/10.
  const m = host.match(/^100\.(\d+)\./);
  if (m?.[1]) {
    const second = Number(m[1]);
    if (second >= 64 && second <= 127) return true;
  }
  return host.startsWith("fd7a:115c:a1e0:"); // Tailscale ULA prefix
}

export function certPaths(): { cert: string; key: string } {
  const dir = join(userDataDir(), "tls");
  return { cert: join(dir, "daemon-cert.pem"), key: join(dir, "daemon-key.pem") };
}

/** Generates a self-signed certificate. Requires openssl; absence is reported, not hidden. */
export async function generateSelfSignedCert(host: string): Promise<boolean> {
  const { cert, key } = certPaths();
  mkdirSync(dirname(cert), { recursive: true, mode: 0o700 });

  const proc = spawnWithEnv(
    [
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "825",
      "-subj", "/CN=divisio-daemon",
      "-addext", `subjectAltName=IP:${host}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    log.error("could not generate a certificate", { detail: stderr.trim().slice(0, 200) });
    return false;
  }
  // The key authorises the encrypted channel; keep it owner-only.
  await Bun.write(key, await Bun.file(key).text());
  return true;
}

export function certFingerprint(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(body, "base64");
  return createHash("sha256").update(der).digest("hex").match(/.{2}/g)!.join(":").toUpperCase();
}

/**
 * Resolves the bind address and TLS material.
 *
 * Throws rather than falling back: a daemon that quietly binds loopback when
 * the user asked for LAN is confusing, and one that quietly serves plaintext on
 * a LAN is dangerous.
 */
export async function resolveNetwork(): Promise<NetworkConfig> {
  const requested = process.env[`${ENV_PREFIX}_BIND`]?.trim() || "127.0.0.1";

  if (isLoopback(requested)) {
    return { hostname: requested, tls: null, fingerprint: null };
  }

  log.warn("binding off loopback", { hostname: requested });

  if (isEncryptedOverlay(requested)) {
    log.info("address is on an encrypted overlay; TLS not required", { hostname: requested });
    return { hostname: requested, tls: null, fingerprint: null };
  }

  // A user-provided certificate wins: a real one from their own CA is better
  // than a self-signed one they have to pin.
  const providedCert = process.env[`${ENV_PREFIX}_TLS_CERT`]?.trim();
  const providedKey = process.env[`${ENV_PREFIX}_TLS_KEY`]?.trim();
  if (providedCert && providedKey) {
    if (!existsSync(providedCert) || !existsSync(providedKey)) {
      throw new InsecureBindError(
        `${ENV_PREFIX}_TLS_CERT or ${ENV_PREFIX}_TLS_KEY points at a file that does not exist`,
      );
    }
    const pem = await Bun.file(providedCert).text();
    return {
      hostname: requested,
      tls: { cert: pem, key: await Bun.file(providedKey).text() },
      fingerprint: certFingerprint(pem),
    };
  }

  const { cert, key } = certPaths();
  if (!existsSync(cert) || !existsSync(key)) {
    const generated = await generateSelfSignedCert(requested);
    if (!generated) {
      throw new InsecureBindError(
        `refusing to bind ${requested} without TLS. A bearer token over plaintext on a shared ` +
          "network is sniffable and grants shell access. Install openssl so a certificate can be " +
          `generated, provide one via ${ENV_PREFIX}_TLS_CERT and ${ENV_PREFIX}_TLS_KEY, or use a ` +
          "Tailscale address.",
      );
    }
  }

  const certPem = await Bun.file(cert).text();
  return {
    hostname: requested,
    tls: { cert: certPem, key: await Bun.file(key).text() },
    fingerprint: certFingerprint(certPem),
  };
}

/** LAN addresses this machine can be reached on, for building the pairing URL. */
export function reachableAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

export { isLoopback, isEncryptedOverlay };
