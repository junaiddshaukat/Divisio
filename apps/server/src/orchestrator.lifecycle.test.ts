import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, MockPeerAdapter } from "@divisio/adapters";
import type { DomainEvent, EmitRuntimeEvent, SessionHandle, StartSessionInput } from "@divisio/contracts";
import { Orchestrator, type Broadcaster } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";

class RecordingBus implements Broadcaster {
  readonly eventsLog: DomainEvent[][] = [];
  events(events: DomainEvent[]) {
    this.eventsLog.push(events);
  }
  delta() {}
}

class FailStartAdapter extends MockPeerAdapter {
  override async startSession(_input: StartSessionInput, _emit: EmitRuntimeEvent): Promise<SessionHandle> {
    throw new Error("cli refused to start");
  }
}

describe("daemon crash reconciliation", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;

  afterEach(async () => {
    await orchestrator?.shutdown();
    await Bun.sleep(20);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(adapter = new MockPeerAdapter()) {
    dir = mkdtempSync(join(tmpdir(), "divisio-lifecycle-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    const registry = new AdapterRegistry([adapter]);
    orchestrator = new Orchestrator(store, registry, new RecordingBus());
    return adapter;
  }

  test("reconcileAfterCrash moves leftover running threads to error", async () => {
    setup();
    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });

    store.append([
      { type: "session.status", threadId: thread.id, payload: { threadId: thread.id, status: "running" } },
    ]);
    expect(store.getThread(thread.id)?.status).toBe("running");

    orchestrator.reconcileAfterCrash();
    expect(store.getThread(thread.id)?.status).toBe("error");
  });

  test("reconcileAfterCrash marks preparing lanes as error", async () => {
    setup();
    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    store.append([
      {
        type: "lane.created",
        threadId: null,
        payload: {
          laneId: "lane_crash",
          projectId: project.id,
          title: "stuck",
          branch: "divisio/stuck",
          baseSha: "abc123",
          root: dir,
          port: 4010,
        },
      },
    ]);
    expect(store.getLane("lane_crash")?.status).toBe("preparing");

    orchestrator.reconcileAfterCrash();
    const lane = store.getLane("lane_crash");
    expect(lane?.status).toBe("error");
    expect(lane?.detail).toContain("Daemon restarted");
  });

  test("failed startSession leaves the thread in error, not connecting", async () => {
    setup(new FailStartAdapter());
    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });

    await expect(
      orchestrator.dispatch("turn.send", { threadId: thread.id, text: "hi" }),
    ).rejects.toThrow(/cli refused to start/);

    expect(store.getThread(thread.id)?.status).toBe("error");
  });
});
