/**
 * Latency measurements for the budgets in ADR 0007.
 *
 * Run against a live daemon:
 *   bun apps/server/src/bench.ts
 *
 * These numbers are only meaningful if they measure OUR latency. Provider CLI
 * startup dominates wall-clock time on a real turn and is not ours to fix, so
 * the streaming figure is measured from a synthetic adapter that emits
 * immediately — what is being timed is the path from adapter emit to client
 * frame, which is the part the budget describes.
 */

import { AdapterRegistry } from "@divisio/adapters";
import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type EmitRuntimeEvent,
  type ProviderAdapter,
  type SendTurnInput,
  type SessionHandle,
  type StartSessionInput,
} from "@divisio/contracts";
import { newId } from "@divisio/shared/ids";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.ts";
import { EventStore } from "./store/log.ts";

const CAPS: AdapterCapabilities = {
  sessionResume: false,
  interruptTurn: true,
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

/** Emits immediately so the measurement excludes provider startup. */
class InstantAdapter implements ProviderAdapter {
  readonly kind = "bench";
  readonly label = "Bench";
  readonly tier = "stream" as const;
  readonly capabilities = CAPS;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;
  private emit: EmitRuntimeEvent | null = null;

  async detect() {
    return { available: true, version: "bench", detail: null };
  }
  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    this.emit = emit;
    emit({ type: "status", status: "ready" });
    return { threadId: input.threadId, nativeId: null, close: async () => {} };
  }
  async sendTurn(_h: SessionHandle, turn: SendTurnInput) {
    this.emit?.({ type: "assistant.delta", turnId: turn.turnId, text: "x" });
  }
  async interruptTurn() {}
  async stopSession() {}
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function report(name: string, budgetMs: number, samples: number[]) {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const verdict = p95 <= budgetMs ? "PASS" : "OVER";
  console.log(
    `${verdict.padEnd(5)} ${name.padEnd(34)} p50 ${p50.toFixed(1).padStart(7)}ms  p95 ${p95
      .toFixed(1)
      .padStart(7)}ms  budget ${budgetMs}ms`,
  );
  return { name, budgetMs, p50, p95, pass: p95 <= budgetMs };
}

const home = mkdtempSync(join(tmpdir(), "divisio-bench-"));
const store = new EventStore(join(home, "state.sqlite"));
const registry = new AdapterRegistry([new InstantAdapter()]);

const deltaTimes: number[] = [];
let deltaMark = 0;
const bus = {
  events() {},
  delta() {
    if (deltaMark) deltaTimes.push(performance.now() - deltaMark);
  },
};
const orchestrator = new Orchestrator(store, registry, bus);

const { project } = await orchestrator.dispatch("project.create", { name: "bench", rootPath: home });

// Seed a thread with a large history to make the switch measurement honest.
const { thread } = await orchestrator.dispatch("thread.create", {
  projectId: project.id,
  title: "bench",
  provider: "bench",
});
const seeded = 1000;
store.append(
  Array.from({ length: seeded }, (_, i) => ({
    type: "turn.message" as const,
    threadId: thread.id,
    payload: {
      threadId: thread.id,
      turnId: newId("trn"),
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message ${i} `.repeat(20),
    },
  })),
);

const results = [];

// Thread switch: projection read for a 1k-message thread.
const switchTimes: number[] = [];
for (let i = 0; i < 50; i++) {
  const t0 = performance.now();
  await orchestrator.dispatch("thread.snapshot", { threadId: thread.id });
  switchTimes.push(performance.now() - t0);
}
results.push(report(`thread switch (${seeded} messages)`, 100, switchTimes));

// Turn dispatch through to the first delta reaching the bus. Each turn is
// interrupted by its own id so the next iteration finds the session idle.
for (let i = 0; i < 50; i++) {
  deltaMark = performance.now();
  const { turnId } = await orchestrator.dispatch("turn.send", { threadId: thread.id, text: "go" });
  await orchestrator.dispatch("turn.interrupt", { threadId: thread.id, turnId });
}
results.push(report("turn dispatch → first delta", 100, deltaTimes));

// Event log append, the write on every turn.
const appendTimes: number[] = [];
for (let i = 0; i < 200; i++) {
  const t0 = performance.now();
  store.append([
    {
      type: "session.status",
      threadId: thread.id,
      payload: { threadId: thread.id, status: "ready" },
    },
  ]);
  appendTimes.push(performance.now() - t0);
}
results.push(report("event append + projection", 10, appendTimes));

// Daemon cold start, measured on the compiled binary that actually ships.
const daemonBin = join(
  import.meta.dir,
  "../../desktop/src-tauri/binaries/divisio-daemon-aarch64-apple-darwin",
);
if (await Bun.file(daemonBin).exists()) {
  // First launch pages a 58 MB binary in from disk; later launches hit the OS
  // page cache. Averaging those together hides both numbers, so the first
  // sample is reported separately as the post-install cost.
  const startTimes: number[] = [];
  let firstLaunch = 0;
  for (let i = 0; i < 6; i++) {
    const benchHome = mkdtempSync(join(tmpdir(), "divisio-boot-"));
    const port = 4700 + i;
    const t = performance.now();
    const proc = Bun.spawn([daemonBin], {
      env: { ...process.env, DIVISIO_HOME: benchHome, DIVISIO_PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) break;
      } catch {
        await Bun.sleep(5);
      }
    }
    const elapsed = performance.now() - t;
    if (i === 0) firstLaunch = elapsed;
    else startTimes.push(elapsed);
    proc.kill();
    await proc.exited;
    rmSync(benchHome, { recursive: true, force: true });
  }
  results.push(report("daemon start (warm page cache)", 500, startTimes));
  console.log(
    `      first launch after install    ${firstLaunch.toFixed(0)}ms — one-off cost of paging in the binary`,
  );
} else {
  console.log("      daemon cold start              skipped — run `bun run --cwd apps/desktop build:daemon`");
}

// Projection rebuild, the recovery path.
const t0 = performance.now();
const replayed = store.rebuildProjections();
console.log(
  `      projection rebuild             ${(performance.now() - t0).toFixed(0)}ms for ${replayed} events`,
);

store.close();
rmSync(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.log(`\n${failed.length} budget(s) exceeded: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("\nall budgets met");
