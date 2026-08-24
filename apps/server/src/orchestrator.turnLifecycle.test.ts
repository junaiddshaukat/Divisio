/**
 * Regressions for turn-lifecycle state that outlived its turn.
 *
 * Each test here corresponds to a bug where the orchestrator's bookkeeping and
 * the adapter's actual state disagreed, which the user saw as a wedged thread
 * or a silently dropped error.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, MockPeerAdapter } from "@divisio/adapters";
import type { DomainEvent } from "@divisio/contracts";
import { Orchestrator, type Broadcaster } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";

class RecordingBus implements Broadcaster {
  readonly eventsLog: DomainEvent[][] = [];
  events(events: DomainEvent[]) {
    this.eventsLog.push(events);
  }
  delta() {}
}

const typesFor = (bus: RecordingBus, threadId: string) =>
  bus.eventsLog.flat().filter((e) => e.threadId === threadId).map((e) => e.type);

describe("turn lifecycle bookkeeping", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;
  let mock: MockPeerAdapter;
  let bus: RecordingBus;

  afterEach(async () => {
    await orchestrator?.shutdown();
    await Bun.sleep(50);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "divisio-lifecycle-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    mock = new MockPeerAdapter({ turnDelayMs: 200 });
    bus = new RecordingBus();
    orchestrator = new Orchestrator(store, new AdapterRegistry([mock]), bus);
    const { project } = await orchestrator.dispatch("project.create", { name: "demo", rootPath: dir });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: mock.kind,
    });
    return thread;
  }

  test("a thread accepts a new turn after Stop", async () => {
    const thread = await setup();

    const first = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    await orchestrator.dispatch("turn.interrupt", { threadId: thread.id, turnId: first.turnId });

    // Stale per-turn state used to make every later send fail as busy.
    const second = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });
    expect(second.turnId).not.toBe(first.turnId);
  });

  test("Stop twice on the same turn does not wedge the thread", async () => {
    const thread = await setup();
    const { turnId } = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });

    await orchestrator.dispatch("turn.interrupt", { threadId: thread.id, turnId });
    // The turn is no longer running, so a second Stop is a client-visible error
    // rather than something that quietly corrupts session state.
    await expect(
      orchestrator.dispatch("turn.interrupt", { threadId: thread.id, turnId }),
    ).rejects.toThrow();

    const next = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });
    expect(next.turnId).toBeString();
  });

  test("a completed turn is reported once and clears its stopping mark", async () => {
    const thread = await setup();
    const { turnId } = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    await Bun.sleep(400);

    const completed = typesFor(bus, thread.id).filter((t) => t === "turn.completed");
    expect(completed.length).toBe(1);

    // A later turn must still be able to report a failure. When the stopping
    // mark outlived its turn, every subsequent provider error was swallowed.
    const again = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "again" });
    expect(again.turnId).not.toBe(turnId);
  });
});

describe("warm session management", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;

  afterEach(async () => {
    await orchestrator?.shutdown();
    await Bun.sleep(50);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setupThreads(count: number) {
    dir = mkdtempSync(join(tmpdir(), "divisio-warm-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    const mock = new MockPeerAdapter({ turnDelayMs: 50 });
    orchestrator = new Orchestrator(store, new AdapterRegistry([mock]), new RecordingBus());
    const { project } = await orchestrator.dispatch("project.create", { name: "demo", rootPath: dir });
    const threads = [];
    for (let i = 0; i < count; i += 1) {
      const { thread } = await orchestrator.dispatch("thread.create", {
        projectId: project.id,
        title: `t${i}`,
        provider: mock.kind,
      });
      threads.push(thread);
    }
    return threads;
  }

  const liveCount = (o: Orchestrator) =>
    (o as unknown as { sessions: Map<string, unknown> }).sessions.size;

  test("opening a thread warms its session ahead of the first turn", async () => {
    const [thread] = await setupThreads(1);
    expect(liveCount(orchestrator)).toBe(0);

    await orchestrator.dispatch("thread.snapshot", { threadId: thread!.id });
    // Prewarm is fire-and-forget; give the microtask queue a beat.
    await Bun.sleep(50);
    expect(liveCount(orchestrator)).toBe(1);
  });

  test("warm sessions stay under the cap as threads are opened", async () => {
    const threads = await setupThreads(7);
    for (const thread of threads) {
      await orchestrator.dispatch("thread.snapshot", { threadId: thread.id });
      await Bun.sleep(30);
    }
    // Warm processes cost hundreds of MB each, so opening seven threads must
    // not hold seven of them.
    expect(liveCount(orchestrator)).toBeLessThanOrEqual(2);
    expect(liveCount(orchestrator)).toBeGreaterThan(0);
  });

  test("a prewarmed session still serves a turn normally", async () => {
    const [thread] = await setupThreads(1);
    await orchestrator.dispatch("thread.snapshot", { threadId: thread!.id });
    await Bun.sleep(50);

    const { turnId } = await orchestrator.dispatch("turn.send", {
      threadId: thread!.id,
      text: "hi",
    });
    expect(turnId).toBeString();
  });
});

/**
 * People type their next instruction while watching the agent work. Rejecting
 * that was technically defensible and read as broken.
 */
describe("sending while a turn is running", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;
  let bus: RecordingBus;

  afterEach(async () => {
    await orchestrator?.shutdown();
    await Bun.sleep(50);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setup(turnDelayMs = 300) {
    dir = mkdtempSync(join(tmpdir(), "divisio-queue-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    bus = new RecordingBus();
    const mock = new MockPeerAdapter({ turnDelayMs });
    orchestrator = new Orchestrator(store, new AdapterRegistry([mock]), bus);
    const { project } = await orchestrator.dispatch("project.create", { name: "d", rootPath: dir });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: mock.kind,
    });
    return thread;
  }

  const payloadsOf = (type: string) =>
    bus.eventsLog.flat().filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);

  test("a message sent mid-turn is queued rather than refused", async () => {
    const thread = await setup();
    const first = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    const second = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });

    expect(second.queued).toBe(true);
    expect(second.turnId).not.toBe(first.turnId);
    expect(payloadsOf("turn.queued").map((p) => p.text)).toEqual(["two"]);
  });

  test("the queued message runs once the current turn settles", async () => {
    const thread = await setup(150);
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    const queued = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });

    await Bun.sleep(700);
    const started = payloadsOf("turn.started").map((p) => p.turnId);
    expect(started).toContain(queued.turnId);
    // And it keeps the id it was given while waiting, so the UI can track it.
    const userText = payloadsOf("turn.message")
      .filter((p) => p.role === "user")
      .map((p) => p.text);
    expect(userText).toEqual(["one", "two"]);
  });

  test("queue order is preserved", async () => {
    const thread = await setup(120);
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "three" });

    await Bun.sleep(1200);
    const userText = payloadsOf("turn.message")
      .filter((p) => p.role === "user")
      .map((p) => p.text);
    expect(userText).toEqual(["one", "two", "three"]);
  });

  test("a queued message can be cancelled before it runs", async () => {
    const thread = await setup();
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    const queued = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });

    const res = await orchestrator.dispatch("turn.dequeue", {
      threadId: thread.id,
      turnId: queued.turnId,
    });
    expect(res.removed).toBe(true);

    await Bun.sleep(600);
    const userText = payloadsOf("turn.message")
      .filter((p) => p.role === "user")
      .map((p) => p.text);
    expect(userText).toEqual(["one"]);
  });

  test("Stop abandons what was typed behind it", async () => {
    const thread = await setup(500);
    const first = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "two" });

    await orchestrator.dispatch("turn.interrupt", { threadId: thread.id, turnId: first.turnId });
    await Bun.sleep(500);

    // Draining after an explicit Stop would start the work just cancelled.
    const userText = payloadsOf("turn.message")
      .filter((p) => p.role === "user")
      .map((p) => p.text);
    expect(userText).toEqual(["one"]);
    expect(payloadsOf("turn.dequeued")).toHaveLength(1);
  });

  test("cancelling an unknown id reports that nothing was removed", async () => {
    const thread = await setup();
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "one" });
    const res = await orchestrator.dispatch("turn.dequeue", {
      threadId: thread.id,
      turnId: "trn_nope",
    });
    expect(res.removed).toBe(false);
  });
});
