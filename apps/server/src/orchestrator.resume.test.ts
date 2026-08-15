import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, MockPeerAdapter } from "@divisio/adapters";
import type { DomainEvent } from "@divisio/contracts";
import { Orchestrator, type Broadcaster } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";

class RecordingBus implements Broadcaster {
  events(_events: DomainEvent[]) {}
  delta() {}
}

describe("vendor session resume", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;

  afterEach(async () => {
    await orchestrator?.shutdown();
    await Bun.sleep(50);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(mock: MockPeerAdapter) {
    orchestrator = new Orchestrator(store, new AdapterRegistry([mock]), new RecordingBus());
  }

  async function setup(mock: MockPeerAdapter) {
    dir = mkdtempSync(join(tmpdir(), "divisio-resume-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    await boot(mock);
    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });
    return thread;
  }

  test("persists the CLI session id and passes it on the next start", async () => {
    const first = new MockPeerAdapter({ turnDelayMs: 5 });
    const thread = await setup(first);

    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    expect(store.getThread(thread.id)?.vendorSessionId).toBe("mock-native-1");
    expect(first.startInputs[0]?.resumeId).toBeUndefined();

    await orchestrator.shutdown();

    const second = new MockPeerAdapter({ turnDelayMs: 5 });
    await boot(second);
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "again" });

    expect(second.startInputs[0]?.resumeId).toBe("mock-native-1");
    expect(store.getThread(thread.id)?.vendorResume).toBe("resumed");
  });

  test("records cold on first start and unsupported when the adapter cannot resume", async () => {
    const first = new MockPeerAdapter({ turnDelayMs: 5 });
    const thread = await setup(first);

    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    expect(store.getThread(thread.id)?.vendorResume).toBe("cold");

    await orchestrator.shutdown();

    const second = new MockPeerAdapter({ turnDelayMs: 5, sessionResume: false });
    await boot(second);
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "again" });

    expect(second.startInputs[0]?.resumeId).toBeUndefined();
    expect(store.getThread(thread.id)?.vendorResume).toBe("unsupported");
  });

  test("records failed when startSession throws after resumeId", async () => {
    const first = new MockPeerAdapter({ turnDelayMs: 5 });
    const thread = await setup(first);

    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    await orchestrator.shutdown();

    const second = new MockPeerAdapter({ turnDelayMs: 5, failResume: true });
    await boot(second);
    await expect(
      orchestrator.dispatch("turn.send", { threadId: thread.id, text: "again" }),
    ).rejects.toThrow("vendor refused resume");

    expect(second.startInputs[0]?.resumeId).toBe("mock-native-1");
    expect(store.getThread(thread.id)?.vendorResume).toBe("failed");
  });

  test("persists usage.reported as turn.usage without inventing totals", async () => {
    const mock = new MockPeerAdapter({
      turnDelayMs: 5,
      script: [
        { type: "assistant.message", text: "ok" },
        { type: "usage.reported", inputTokens: 12, outputTokens: 4 },
      ],
    });
    const thread = await setup(mock);
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    const deadline = Date.now() + 2000;
    while (store.readSince(0).filter((e) => e.type === "turn.usage").length === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for turn.usage");
      await Bun.sleep(10);
    }

    const usage = store.readSince(0).filter((e) => e.type === "turn.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload).toEqual({
      threadId: thread.id,
      turnId: expect.any(String),
      provider: "mock",
      inputTokens: 12,
      outputTokens: 4,
    });
  });

  test("does not pass resumeId when the adapter cannot resume", async () => {
    const first = new MockPeerAdapter({ turnDelayMs: 5, sessionResume: false });
    const thread = await setup(first);

    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    expect(store.getThread(thread.id)?.vendorSessionId).toBe("mock-native-1");

    await orchestrator.shutdown();

    const second = new MockPeerAdapter({ turnDelayMs: 5, sessionResume: false });
    await boot(second);
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "again" });

    expect(second.startInputs[0]?.resumeId).toBeUndefined();
  });
});
