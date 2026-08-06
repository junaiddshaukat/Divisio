import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapabilities,
  type DetectResult,
  type EmitRuntimeEvent,
  type ProviderAdapter,
  type SendTurnInput,
  type SessionHandle,
  type StartSessionInput,
} from "@divisio/contracts";
import { AdapterRegistry, loadCommunityAdapters } from "../index.ts";

const caps: AdapterCapabilities = {
  sessionResume: false,
  interruptTurn: true,
  modelSwitch: false,
  approvals: false,
  handoffExport: false,
  worktreeAware: true,
  usageSignals: false,
};

class StubCommunityAdapter implements ProviderAdapter {
  readonly kind = "stub-community";
  readonly label = "Stub Community";
  readonly tier = "stream" as const;
  readonly capabilities = caps;
  readonly contractVersion = ADAPTER_CONTRACT_VERSION;

  async detect(): Promise<DetectResult> {
    return { available: true, version: "0.0.1", detail: null };
  }
  async startSession(input: StartSessionInput, emit: EmitRuntimeEvent): Promise<SessionHandle> {
    emit({ type: "status", status: "ready" });
    return { threadId: input.threadId, nativeId: null, close: async () => undefined };
  }
  async sendTurn(_s: SessionHandle, _t: SendTurnInput): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(s: SessionHandle): Promise<void> {
    await s.close();
  }
}

describe("loadCommunityAdapters", () => {
  test("registers community module and marks source", async () => {
    const registry = new AdapterRegistry([]);
    registry.register(new StubCommunityAdapter(), { source: "community" });
    expect(registry.sourceOf("stub-community")).toBe("community");

    const stubPath = join(import.meta.dir, "../../fixtures/community-stub.ts");
    const result = await loadCommunityAdapters({
      registry,
      builtinModules: [],
      configPath: join(tmpdir(), "no-adapters.json"),
      envModules: [stubPath],
    });

    expect(result.failed).toEqual([]);
    expect(result.loaded).toContain("stub-from-file");
    expect(registry.sourceOf("stub-from-file")).toBe("community");
    expect(registry.get("stub-from-file")?.label).toBe("Stub From File");
  });

  test("builtin community pack loads gemini/copilot/antigravity", async () => {
    const registry = new AdapterRegistry([]);
    const result = await loadCommunityAdapters({
      registry,
      builtinModules: ["@divisio/community-adapters"],
      configPath: join(tmpdir(), "no-adapters.json"),
      envModules: [],
    });
    expect(result.failed).toEqual([]);
    expect(result.loaded.sort()).toEqual(["antigravity", "copilot", "gemini"]);
    expect(registry.sourceOf("gemini")).toBe("community");
    expect(registry.sourceOf("copilot")).toBe("community");
    expect(registry.sourceOf("antigravity")).toBe("community");
  });
});
