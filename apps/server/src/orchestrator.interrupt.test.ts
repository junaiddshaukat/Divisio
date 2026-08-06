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

function statusPayloads(bus: RecordingBus, threadId: string): string[] {
  return bus.eventsLog
    .flat()
    .filter((e) => e.type === "session.status" && e.threadId === threadId)
    .map((e) => (e.payload as { status: string }).status);
}

describe("interrupt → stopping (mock peer)", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;
  let mock: MockPeerAdapter;

  afterEach(async () => {
    await orchestrator?.shutdown();
    // Let async checkpoint finalize settle before closing the store.
    await Bun.sleep(50);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "divisio-interrupt-"));
    // project.create requires an existing path
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    mock = new MockPeerAdapter({ turnDelayMs: 500 });
    const registry = new AdapterRegistry([mock]);
    const bus = new RecordingBus();
    orchestrator = new Orchestrator(store, registry, bus);
    return bus;
  }

  test("interrupt emits stopping before ready, and turn.interrupted is committed", async () => {
    const bus = await setup();

    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });

    const { turnId } = await orchestrator.dispatch("turn.send", {
      threadId: thread.id,
      text: "slow please",
    });

    // Let the mock mark running, then interrupt before the delayed script fires.
    await Bun.sleep(20);
    expect(mock.statusLog).toContain("running");

    await orchestrator.dispatch("turn.interrupt", { threadId: thread.id, turnId });

    expect(mock.statusLog).toContain("stopping");
    // stopping must appear before the post-interrupt ready
    const stopIdx = mock.statusLog.indexOf("stopping");
    const readyAfter = mock.statusLog.indexOf("ready", stopIdx + 1);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(readyAfter).toBeGreaterThan(stopIdx);

    const statuses = statusPayloads(bus, thread.id);
    expect(statuses).toContain("stopping");

    const interrupted = bus.eventsLog
      .flat()
      .some((e) => e.type === "turn.interrupted" && (e.payload as { turnId: string }).turnId === turnId);
    expect(interrupted).toBe(true);

    expect(store.getThread(thread.id)?.status).toBe("ready");
  });

  test("mock peer completes a turn without a live CLI", async () => {
    const bus = await setup();
    mock = new MockPeerAdapter({ turnDelayMs: 10 });
    const registry = new AdapterRegistry([mock]);
    orchestrator = new Orchestrator(store, registry, bus);

    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });
    const { turnId } = await orchestrator.dispatch("turn.send", {
      threadId: thread.id,
      text: "hi",
    });

    await Bun.sleep(80);

    const messages = store.listMessages(thread.id);
    expect(messages.some((m) => m.role === "user" && m.text === "hi")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.text === "hello world")).toBe(true);
    expect(
      bus.eventsLog.flat().some((e) => e.type === "turn.completed" && (e.payload as { turnId: string }).turnId === turnId),
    ).toBe(true);
  });
});
