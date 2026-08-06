import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, MockPeerAdapter } from "@divisio/adapters";
import { CommandError, type DomainEvent, type ProviderAdapter } from "@divisio/contracts";
import { Orchestrator, type Broadcaster } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";

class RecordingBus implements Broadcaster {
  events(_events: DomainEvent[]) {}
  delta() {}
}

/** Second mock kind so setProvider can switch adapters in tests. */
class MockBAdapter extends MockPeerAdapter {
  override readonly kind = "mock-b";
  override readonly label = "Mock B";
}

describe("thread.setProvider", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;

  afterEach(async () => {
    await orchestrator?.shutdown();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "divisio-setprovider-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    const adapters: ProviderAdapter[] = [new MockPeerAdapter({ turnDelayMs: 5 }), new MockBAdapter({ turnDelayMs: 5 })];
    orchestrator = new Orchestrator(store, new AdapterRegistry(adapters), new RecordingBus());
    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "empty",
      provider: "mock",
    });
    return { thread };
  }

  test("empty thread can switch provider and model", async () => {
    const { thread } = await setup();
    const res = await orchestrator.dispatch("thread.setProvider", {
      threadId: thread.id,
      provider: "mock-b",
      model: "gpt-test",
    });
    expect(res.thread.provider).toBe("mock-b");
    expect(res.thread.model).toBe("gpt-test");
  });

  test("history blocks provider change", async () => {
    const { thread } = await setup();
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    await Bun.sleep(40);
    await expect(
      orchestrator.dispatch("thread.setProvider", {
        threadId: thread.id,
        provider: "mock-b",
      }),
    ).rejects.toBeInstanceOf(CommandError);
  });

  test("history still allows model-only change", async () => {
    const { thread } = await setup();
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" });
    await Bun.sleep(40);
    const res = await orchestrator.dispatch("thread.setProvider", {
      threadId: thread.id,
      provider: "mock",
      model: "model-x",
    });
    expect(res.thread.provider).toBe("mock");
    expect(res.thread.model).toBe("model-x");
  });
});
