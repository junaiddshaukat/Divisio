import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@divisio/contracts";
import type { ServerWebSocket } from "bun";
import { EventStore } from "./store/log.ts";
import { WsHub, type SocketData } from "./ws.ts";

/** Minimal stand-in for Bun's ServerWebSocket — enough for resume unit tests. */
function fakeWs(threads: string[] = []): ServerWebSocket<SocketData> & { sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  const ws = {
    sent,
    data: {
      clientId: "ses_test",
    pairedClientId: null,
      threads: new Set(threads),
      pending: new Map(),
      timer: null,
      catchUp: false,
    } satisfies SocketData,
    send(data: string) {
      sent.push(JSON.parse(data) as ServerFrame);
    },
    getBufferedAmount() {
      return 0;
    },
  };
  return ws as unknown as ServerWebSocket<SocketData> & { sent: ServerFrame[] };
}

describe("session.resume", () => {
  let dir: string;
  let store: EventStore;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(replayWindow = 10) {
    dir = mkdtempSync(join(tmpdir(), "divisio-resume-"));
    store = new EventStore(join(dir, "state.sqlite"));
    const hub = new WsHub(store, "env_test", { replayWindow });
    return hub;
  }

  test("inside retention → replay + gap events", async () => {
    const hub = setup(10);
    store.append([
      {
        type: "project.created",
        threadId: null,
        payload: { projectId: "prj_1", name: "demo", rootPath: dir },
      },
      {
        type: "thread.created",
        threadId: "thr_1",
        payload: { threadId: "thr_1", projectId: "prj_1", title: "t", provider: "mock" },
      },
      {
        type: "turn.message",
        threadId: "thr_1",
        payload: { threadId: "thr_1", turnId: "trn_1", role: "user", text: "hi" },
      },
    ]);
    const head = store.head();
    expect(head).toBe(3);

    const ws = fakeWs();
    hub.open(ws, "divisio.v1");
    ws.sent.length = 0;

    await hub.message(
      ws,
      JSON.stringify({
        t: "req",
        id: "r1",
        cmd: "session.resume",
        payload: { since: 1, threads: ["thr_1"] },
      }),
    );

    const res = ws.sent.find((f) => f.t === "res" && f.id === "r1");
    expect(res).toEqual({
      t: "res",
      id: "r1",
      payload: { mode: "replay", through: head },
    });

    const evts = ws.sent.filter((f) => f.t === "evt");
    expect(evts.length).toBe(2); // thread.created + turn.message (project.created filtered: null thread ok actually)

    // project.created has threadId null → always delivered
    // thread.created thr_1 → subscribed
    // turn.message thr_1 → subscribed
    // since=1 means seq>1, so project(1) skipped, thread(2)+message(3) delivered
    // Wait - project has threadId null, so it's delivered if seq>1. seq 2 and 3.
    // project is seq 1, skipped. So 2 events. Good.

    expect(evts.map((f) => (f.t === "evt" ? f.event.type : null))).toEqual([
      "thread.created",
      "turn.message",
    ]);
  });

  test("past retention → snapshot_required (routine, not an error)", async () => {
    const hub = setup(2);
    for (let i = 0; i < 5; i++) {
      store.append([
        {
          type: "project.created",
          threadId: null,
          payload: { projectId: `prj_${i}`, name: `p${i}`, rootPath: dir },
        },
      ]);
    }
    const head = store.head();
    expect(head).toBe(5);

    const ws = fakeWs();
    await hub.message(
      ws,
      JSON.stringify({
        t: "req",
        id: "r2",
        cmd: "session.resume",
        payload: { since: 1, threads: [] },
      }),
    );

    // head - since = 4 > replayWindow 2
    const res = ws.sent.find((f) => f.t === "res" && f.id === "r2");
    expect(res).toEqual({
      t: "res",
      id: "r2",
      payload: { mode: "snapshot_required" },
    });
    expect(ws.sent.some((f) => f.t === "evt")).toBe(false);
  });

  test("since ahead of head → snapshot_required", async () => {
    const hub = setup(10);
    store.append([
      {
        type: "project.created",
        threadId: null,
        payload: { projectId: "prj_1", name: "demo", rootPath: dir },
      },
    ]);

    const ws = fakeWs();
    await hub.message(
      ws,
      JSON.stringify({
        t: "req",
        id: "r3",
        cmd: "session.resume",
        payload: { since: 99, threads: [] },
      }),
    );

    expect(ws.sent.find((f) => f.t === "res" && f.id === "r3")).toEqual({
      t: "res",
      id: "r3",
      payload: { mode: "snapshot_required" },
    });
  });
});
