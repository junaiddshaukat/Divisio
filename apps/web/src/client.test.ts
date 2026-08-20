import { describe, expect, test } from "bun:test";
import { REQUIRED_COMMANDS } from "@divisio/contracts";
import { Client, type ConnectionState } from "./client.ts";

function readyFrame(): string {
  return JSON.stringify({
    t: "ready",
    protocol: "divisio.v1",
    environmentId: "env_test",
    seq: 1,
    generation: 2,
    commands: [...REQUIRED_COMMANDS],
  });
}

function serveWs() {
  const sockets = new Set<{ close(): void }>();
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(readyFrame());
      },
      message() {},
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    sockets,
    stop: () => server.stop(true),
  };
}

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("Client connection", () => {
  test("reaches open and close() does not flash disconnected or reconnect", async () => {
    const daemon = serveWs();
    const states: ConnectionState[] = [];
    const client = new Client(daemon.url, "test-token", {
      onIncompatible() {},
      onEvent() {},
      onDelta() {},
      onState(state) {
        states.push(state);
      },
      onResync() {},
    });
    try {
      client.connect();
      await waitFor(() => states.includes("open"));
      client.close();
      await Bun.sleep(120);
      expect(states.filter((s) => s === "closed")).toEqual([]);
      expect(daemon.sockets.size).toBe(0);
    } finally {
      client.close();
      daemon.stop();
    }
  });

  test("a stale socket close does not drop a newer connection", async () => {
    const daemon = serveWs();
    const states: ConnectionState[] = [];
    const client = new Client(daemon.url, "test-token", {
      onIncompatible() {},
      onEvent() {},
      onDelta() {},
      onState(state) {
        states.push(state);
      },
      onResync() {},
    });
    try {
      client.connect();
      await waitFor(() => states.at(-1) === "open");
      client.connect();
      await waitFor(() => daemon.sockets.size === 1 && states.filter((s) => s === "open").length >= 2);
      await Bun.sleep(50);
      expect(states.at(-1)).toBe("open");
      expect(states.includes("closed")).toBe(false);
    } finally {
      client.close();
      daemon.stop();
    }
  });
});
