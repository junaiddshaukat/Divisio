import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "./log.ts";

describe("EventStore projections", () => {
  let dir: string;
  let store: EventStore;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "divisio-store-"));
    store = new EventStore(join(dir, "state.sqlite"));
  }

  test("rebuildProjections restores projects, threads, and messages identically", () => {
    setup();

    store.append([
      {
        type: "project.created",
        threadId: null,
        payload: { projectId: "prj_a", name: "Alpha", rootPath: "/tmp/a" },
      },
      {
        type: "thread.created",
        threadId: "thr_a",
        payload: { threadId: "thr_a", projectId: "prj_a", title: "Hello", provider: "mock" },
      },
      {
        type: "turn.message",
        threadId: "thr_a",
        payload: { threadId: "thr_a", turnId: "trn_1", role: "user", text: "ping" },
      },
      {
        type: "turn.message",
        threadId: "thr_a",
        payload: { threadId: "thr_a", turnId: "trn_1", role: "assistant", text: "pong" },
      },
      {
        type: "session.status",
        threadId: "thr_a",
        payload: { threadId: "thr_a", status: "ready" },
      },
    ]);

    const before = {
      head: store.head(),
      projects: store.listProjects(),
      threads: store.listThreads(),
      messages: store.listMessages("thr_a"),
    };

    const n = store.rebuildProjections();
    expect(n).toBe(5);

    expect(store.head()).toBe(before.head);
    expect(store.listProjects()).toEqual(before.projects);
    expect(store.listThreads()).toEqual(before.threads);
    expect(store.listMessages("thr_a")).toEqual(before.messages);
  });

  test("readSince returns events after the cursor in order", () => {
    setup();
    store.append([
      {
        type: "project.created",
        threadId: null,
        payload: { projectId: "prj_1", name: "p", rootPath: "/tmp" },
      },
      {
        type: "project.created",
        threadId: null,
        payload: { projectId: "prj_2", name: "q", rootPath: "/tmp" },
      },
    ]);

    const gap = store.readSince(1);
    expect(gap.map((e) => e.seq)).toEqual([2]);
    expect(gap[0]?.type).toBe("project.created");
  });
});
