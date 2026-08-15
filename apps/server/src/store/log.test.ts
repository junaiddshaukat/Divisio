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

  test("activityStats is empty on a fresh store", () => {
    setup();
    const stats = store.activityStats();
    expect(stats.totals.turns).toBe(0);
    expect(stats.totals.activeDays).toBe(0);
    expect(stats.days.length).toBeGreaterThan(300);
    expect(stats.providers).toEqual([]);
  });

  test("activityStats counts turns by provider and day", () => {
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
        payload: { threadId: "thr_a", projectId: "prj_a", title: "Hello", provider: "claude" },
      },
      {
        type: "turn.started",
        threadId: "thr_a",
        payload: { threadId: "thr_a", turnId: "trn_1", provider: "claude" },
      },
      {
        type: "turn.message",
        threadId: "thr_a",
        payload: { threadId: "thr_a", turnId: "trn_1", role: "user", text: "ping" },
      },
      {
        type: "turn.started",
        threadId: "thr_a",
        payload: { threadId: "thr_a", turnId: "trn_2", provider: "claude" },
      },
      {
        type: "turn.message",
        threadId: "thr_a",
        payload: { threadId: "thr_a", turnId: "trn_2", role: "user", text: "pong" },
      },
    ]);

    const stats = store.activityStats();
    expect(stats.totals.turns).toBe(2);
    expect(stats.totals.messages).toBe(2);
    expect(stats.totals.projects).toBe(1);
    expect(stats.totals.threads).toBe(1);
    expect(stats.providers).toEqual([{ kind: "claude", turns: 2 }]);
    expect(stats.totals.activeDays).toBe(1);
    expect(stats.totals.currentStreak).toBeGreaterThanOrEqual(1);
  });

  test("rename and soft-delete update the thread projection", () => {
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
        type: "thread.renamed",
        threadId: "thr_a",
        payload: { threadId: "thr_a", title: "Renamed" },
      },
    ]);
    expect(store.getThread("thr_a")?.title).toBe("Renamed");

    store.append([
      {
        type: "thread.deleted",
        threadId: "thr_a",
        payload: { threadId: "thr_a" },
      },
    ]);
    expect(store.getThread("thr_a")).toBeNull();
    expect(store.listThreads()).toEqual([]);
  });

  test("project.removed hides the project and its threads without needing disk cleanup", () => {
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
        type: "project.removed",
        threadId: null,
        payload: { projectId: "prj_a" },
      },
    ]);
    expect(store.listProjects()).toEqual([]);
    expect(store.getProject("prj_a")).toBeNull();
    expect(store.listThreads()).toEqual([]);
  });

  test("vendor session id survives rebuild and clears when the provider changes", () => {
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
        type: "thread.vendor_session_set",
        threadId: "thr_a",
        payload: { threadId: "thr_a", nativeId: "ses_vendor_1", provider: "mock" },
      },
    ]);
    expect(store.getThread("thr_a")?.vendorSessionId).toBe("ses_vendor_1");

    const n = store.rebuildProjections();
    expect(n).toBe(3);
    expect(store.getThread("thr_a")?.vendorSessionId).toBe("ses_vendor_1");

    store.append([
      {
        type: "thread.provider_set",
        threadId: "thr_a",
        payload: { threadId: "thr_a", provider: "mock", model: "gpt-test" },
      },
    ]);
    expect(store.getThread("thr_a")?.vendorSessionId).toBe("ses_vendor_1");

    store.append([
      {
        type: "thread.provider_set",
        threadId: "thr_a",
        payload: { threadId: "thr_a", provider: "other", model: null },
      },
    ]);
    expect(store.getThread("thr_a")?.vendorSessionId).toBeNull();
  });
});
