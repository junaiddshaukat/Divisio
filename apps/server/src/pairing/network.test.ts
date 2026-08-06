import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certFingerprint, InsecureBindError, isEncryptedOverlay, isLoopback, resolveNetwork } from "./network.ts";

/**
 * The bind policy is the rule that keeps a shell-spawning daemon off a shared
 * network in plaintext. These pin the classification it depends on.
 */

describe("bind classification", () => {
  test("loopback addresses are recognised", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopback(host)).toBe(true);
    }
  });

  test("LAN addresses are not loopback", () => {
    for (const host of ["192.168.1.10", "10.0.0.5", "0.0.0.0"]) {
      expect(isLoopback(host)).toBe(false);
    }
  });

  test("Tailscale addresses count as an encrypted overlay", () => {
    // The link is already encrypted, so requiring a self-signed cert on top
    // would be friction without benefit.
    expect(isEncryptedOverlay("100.64.0.1")).toBe(true);
    expect(isEncryptedOverlay("100.101.102.103")).toBe(true);
    expect(isEncryptedOverlay("fd7a:115c:a1e0::1")).toBe(true);
  });

  test("ordinary LAN addresses do not count as an overlay", () => {
    // 100.x outside the CGNAT range is public space, not Tailscale.
    expect(isEncryptedOverlay("100.200.0.1")).toBe(false);
    expect(isEncryptedOverlay("192.168.1.10")).toBe(false);
    expect(isEncryptedOverlay("10.0.0.5")).toBe(false);
  });
});

describe("certificate fingerprint", () => {
  test("is a stable colon-separated SHA-256 of the DER body", () => {
    const pem = [
      "-----BEGIN CERTIFICATE-----",
      Buffer.from("divisio-test-certificate").toString("base64"),
      "-----END CERTIFICATE-----",
    ].join("\n");
    const fp = certFingerprint(pem);
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(certFingerprint(pem)).toBe(fp);
  });
});

describe("bind policy", () => {
  const ORIGINAL = { bind: process.env["DIVISIO_BIND"], path: process.env["PATH"] };
  afterEach(() => {
    if (ORIGINAL.bind === undefined) delete process.env["DIVISIO_BIND"];
    else process.env["DIVISIO_BIND"] = ORIGINAL.bind;
    if (ORIGINAL.path !== undefined) process.env["PATH"] = ORIGINAL.path;
  });

  test("loopback needs no TLS", async () => {
    process.env["DIVISIO_BIND"] = "127.0.0.1";
    const net = await resolveNetwork();
    expect(net.tls).toBeNull();
    expect(net.hostname).toBe("127.0.0.1");
  });

  test("the whole 127.0.0.0/8 block is loopback", async () => {
    process.env["DIVISIO_BIND"] = "127.0.0.2";
    expect((await resolveNetwork()).tls).toBeNull();
  });

  test("a Tailscale address binds without TLS", async () => {
    process.env["DIVISIO_BIND"] = "100.101.102.103";
    const net = await resolveNetwork();
    expect(net.hostname).toBe("100.101.102.103");
    expect(net.tls).toBeNull();
  });

  test("a LAN bind refuses when no certificate can be produced", async () => {
    // Shadow openssl with a failing stub: the daemon must refuse rather than
    // serve a bearer token over plaintext on a shared network.
    const dir = await mkdtemp(join(tmpdir(), "divisio-noopenssl-"));
    await writeFile(join(dir, "openssl"), "#!/bin/sh\nexit 1\n");
    await chmod(join(dir, "openssl"), 0o755);
    process.env["PATH"] = `${dir}:${process.env["PATH"]}`;
    process.env["DIVISIO_BIND"] = "192.168.44.44";

    await expect(resolveNetwork()).rejects.toThrow(InsecureBindError);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("provided certificates", () => {
  const ORIGINAL = {
    bind: process.env["DIVISIO_BIND"],
    cert: process.env["DIVISIO_TLS_CERT"],
    key: process.env["DIVISIO_TLS_KEY"],
  };
  afterEach(() => {
    for (const [k, v] of Object.entries({
      DIVISIO_BIND: ORIGINAL.bind,
      DIVISIO_TLS_CERT: ORIGINAL.cert,
      DIVISIO_TLS_KEY: ORIGINAL.key,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a provided certificate is used instead of self-signing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "divisio-cert-"));
    const cert = join(dir, "c.pem");
    const key = join(dir, "k.pem");
    const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from("provided").toString("base64")}\n-----END CERTIFICATE-----`;
    await writeFile(cert, pem);
    await writeFile(key, "KEY");

    process.env["DIVISIO_BIND"] = "192.168.44.44";
    process.env["DIVISIO_TLS_CERT"] = cert;
    process.env["DIVISIO_TLS_KEY"] = key;

    const net = await resolveNetwork();
    expect(net.tls?.cert).toBe(pem);
    expect(net.tls?.key).toBe("KEY");
    expect(net.fingerprint).toBe(certFingerprint(pem));
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing provided certificate refuses rather than silently self-signing", async () => {
    process.env["DIVISIO_BIND"] = "192.168.44.44";
    process.env["DIVISIO_TLS_CERT"] = "/nope/cert.pem";
    process.env["DIVISIO_TLS_KEY"] = "/nope/key.pem";
    await expect(resolveNetwork()).rejects.toThrow(InsecureBindError);
  });
});
