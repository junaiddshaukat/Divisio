import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, MockPeerAdapter } from "@divisio/adapters";
import type { DomainEvent, ProviderAdapter } from "@divisio/contracts";
import { LOG_PACKET_SUMMARY } from "./handoff.ts";
import { Orchestrator, type Broadcaster } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";

class RecordingBus implements Broadcaster {
  events(_events: DomainEvent[]) {}
  delta() {}
}

class MockBAdapter extends MockPeerAdapter {
  override readonly kind = "mock-b";
  override readonly label = "Mock B";
}

describe("thread.handoff", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;
  let source: MockPeerAdapter;
  let target: MockBAdapter;

  afterEach(async () => {
    await orchestrator?.shutdown();
    await Bun.sleep(50);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setup(sourceOpts: ConstructorParameters<typeof MockPeerAdapter>[0] = {}) {
    dir = mkdtempSync(join(tmpdir(), "divisio-handoff-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    source = new MockPeerAdapter({ turnDelayMs: 5, ...sourceOpts });
    target = new MockBAdapter({ turnDelayMs: 5 });
    const adapters: ProviderAdapter[] = [source, target];
    orchestrator = new Orchestrator(store, new AdapterRegistry(adapters), new RecordingBus());
    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "ship search" });
    await Bun.sleep(40);
    return thread;
  }

  test("packet log seeds the target from the transcript without a source note turn", async () => {
    const thread = await setup();
    const before = source.sendTurnTexts.length;

    const res = await orchestrator.dispatch("thread.handoff", {
      threadId: thread.id,
      toProvider: "mock-b",
      packet: "log",
    });

    expect(res.packet).toBe("log");
    expect(res.summary).toBe(LOG_PACKET_SUMMARY);
    expect(source.sendTurnTexts).toHaveLength(before);
    expect(target.sendTurnTexts[0]).toContain("did not write a handover note");
    expect(target.sendTurnTexts[0]).toContain("ship search");

    const link = store.readSince(0).find((e) => e.type === "thread.handed_off");
    expect(link?.payload).toMatchObject({
      fromThreadId: thread.id,
      toThreadId: res.thread.id,
      packet: "log",
    });
  });

  test("falls back to a log packet when the source agent cannot write a note", async () => {
    const thread = await setup({ failAfterTurns: 1 });

    const res = await orchestrator.dispatch("thread.handoff", {
      threadId: thread.id,
      toProvider: "mock-b",
    });

    expect(res.packet).toBe("log");
    expect(res.summary).toBe(LOG_PACKET_SUMMARY);
    expect(target.sendTurnTexts[0]).toContain("BEGIN DIVISIO TRANSCRIPT");
  });
});
