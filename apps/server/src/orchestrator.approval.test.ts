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

function flat(bus: RecordingBus) {
  return bus.eventsLog.flat();
}

describe("approval + permission modes", () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: Orchestrator;
  let mock: MockPeerAdapter;
  let bus: RecordingBus;

  afterEach(async () => {
    await orchestrator?.shutdown();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function setup(options?: ConstructorParameters<typeof MockPeerAdapter>[0]) {
    dir = mkdtempSync(join(tmpdir(), "divisio-approval-"));
    writeFileSync(join(dir, ".keep"), "");
    store = new EventStore(join(dir, "state.sqlite"));
    mock = new MockPeerAdapter({
      turnDelayMs: 10,
      approvals: true,
      script: [
        {
          type: "approval.requested",
          approvalId: "appr_1",
          category: "shell.exec",
          summary: "rm -rf /tmp/x",
        },
        { type: "assistant.message", text: "done" },
      ],
      ...options,
    });
    bus = new RecordingBus();
    orchestrator = new Orchestrator(store, new AdapterRegistry([mock]), bus);

    const { project } = await orchestrator.dispatch("project.create", {
      name: "demo",
      rootPath: dir,
    });
    const { thread } = await orchestrator.dispatch("thread.create", {
      projectId: project.id,
      title: "t",
      provider: "mock",
    });
    return { project, thread };
  }

  test("supervised: approval.requested waits; respond approve completes turn", async () => {
    const { thread } = await setup();
    expect(thread.permissionMode).toBe("supervised");

    const { turnId } = await orchestrator.dispatch("turn.send", {
      threadId: thread.id,
      text: "run it",
    });

    await Bun.sleep(40);
    expect(flat(bus).some((e) => e.type === "approval.requested")).toBe(true);
    expect(mock.statusLog).toContain("awaiting_approval");

    await orchestrator.dispatch("approval.respond", {
      threadId: thread.id,
      approvalId: "appr_1",
      decision: "approve",
    });

    await Bun.sleep(40);
    expect(mock.approvalLog).toEqual([{ approvalId: "appr_1", decision: "approve" }]);
    expect(flat(bus).some((e) => e.type === "approval.resolved")).toBe(true);
    expect(flat(bus).some((e) => e.type === "turn.completed")).toBe(true);
    expect(turnId).toBeTruthy();
  });

  test("full_access: auto-approves without waiting on UI", async () => {
    const { thread } = await setup();
    await orchestrator.dispatch("thread.setPermissionMode", {
      threadId: thread.id,
      mode: "full_access",
    });

    await orchestrator.dispatch("turn.send", {
      threadId: thread.id,
      text: "run it",
    });

    await Bun.sleep(80);
    expect(mock.approvalLog.some((a) => a.decision === "approve")).toBe(true);
    expect(flat(bus).some((e) => e.type === "turn.completed")).toBe(true);
  });

  test("respond to unknown approval → not_found", async () => {
    const { thread } = await setup({
      script: [{ type: "assistant.message", text: "hi" }],
    });
    await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "x" });
    await Bun.sleep(40);

    expect(
      orchestrator.dispatch("approval.respond", {
        threadId: thread.id,
        approvalId: "missing",
        decision: "deny",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
