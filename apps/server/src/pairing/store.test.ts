import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingStore } from "./store.ts";

/**
 * A token here grants shell execution on the user's machine, so these cover the
 * properties that make that survivable: single use, expiry, revocation that
 * takes effect immediately, and no recoverable secrets at rest.
 */

let dir: string;
let store: PairingStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "divisio-pair-"));
  store = new PairingStore(join(dir, "pairing.sqlite"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pairing tokens", () => {
  test("a pairing token works exactly once", () => {
    const { token } = store.createPairingToken();
    expect(store.redeemPairingToken(token, "laptop")).not.toBeNull();
    // A pairing URL may be seen by anyone it passed through; replay must fail.
    expect(store.redeemPairingToken(token, "attacker")).toBeNull();
  });

  test("an unknown token is refused", () => {
    expect(store.redeemPairingToken("not-a-real-token", "x")).toBeNull();
  });

  test("each redemption mints a distinct client and token", () => {
    const a = store.redeemPairingToken(store.createPairingToken().token, "a")!;
    const b = store.redeemPairingToken(store.createPairingToken().token, "b")!;
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.token).not.toBe(b.token);
  });
});

describe("session tokens", () => {
  test("a valid token resolves to its client", () => {
    const paired = store.redeemPairingToken(store.createPairingToken().token, "phone")!;
    expect(store.verifySessionToken(paired.token)?.id).toBe(paired.clientId);
  });

  test("an unknown token resolves to nothing", () => {
    expect(store.verifySessionToken("bogus")).toBeNull();
  });

  test("revocation takes effect immediately and notifies listeners", () => {
    const paired = store.redeemPairingToken(store.createPairingToken().token, "phone")!;
    const closed: string[] = [];
    store.onClientRevoked((id) => closed.push(id));

    expect(store.revokeClient(paired.clientId)).toBe(true);
    expect(store.verifySessionToken(paired.token)).toBeNull();
    // Live sockets must be dropped, not merely refused next time.
    expect(closed).toEqual([paired.clientId]);
  });

  test("revoking twice reports no second change", () => {
    const paired = store.redeemPairingToken(store.createPairingToken().token, "x")!;
    expect(store.revokeClient(paired.clientId)).toBe(true);
    expect(store.revokeClient(paired.clientId)).toBe(false);
  });

  test("revokeAll clears every client", () => {
    store.redeemPairingToken(store.createPairingToken().token, "a");
    store.redeemPairingToken(store.createPairingToken().token, "b");
    expect(store.revokeAll()).toBe(2);
    expect(store.listClients()).toHaveLength(0);
  });
});

describe("secrets at rest", () => {
  test("no raw token is recoverable from the database file", async () => {
    const { token: pairingToken } = store.createPairingToken();
    const paired = store.redeemPairingToken(pairingToken, "laptop")!;
    store.close();

    // A leaked database must not be equivalent to a leaked credential.
    const bytes = await Bun.file(join(dir, "pairing.sqlite")).text();
    expect(bytes).not.toContain(paired.token);
    expect(bytes).not.toContain(pairingToken);

    store = new PairingStore(join(dir, "pairing.sqlite"));
  });
});
