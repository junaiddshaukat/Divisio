import { describe, expect, test } from "bun:test";
import { compactModelLabel, modelLabel, modelsForProvider, triggerModelLabel } from "./providerModels.ts";
import type { ModelCatalog } from "@divisio/contracts";

const live: ModelCatalog = {
  source: "live",
  selectedId: "Qwen-Ambassador/Qwen3.8-Max",
  models: [
    { id: "Qwen-Ambassador/Qwen3.8-Max", label: "[ModelScope] Qwen-Ambassador/Qwen3.8-Max" },
    { id: "Qwen/Qwen3.5-397B-A17B", label: "[ModelScope] Qwen/Qwen3.5-397B-A17B" },
  ],
};

describe("modelsForProvider", () => {
  test("live catalog replaces curated aliases except Default", () => {
    const opts = modelsForProvider("qwen", live);
    expect(opts[0]?.isDefault).toBe(true);
    expect(opts.map((o) => o.id)).toEqual([
      "default",
      "Qwen-Ambassador/Qwen3.8-Max",
      "Qwen/Qwen3.5-397B-A17B",
    ]);
    expect(opts.some((o) => o.id === "qwen3-coder-plus")).toBe(false);
  });

  test("curated fallback when live is none", () => {
    const opts = modelsForProvider("qwen", { source: "none", models: [] });
    expect(opts.some((o) => o.id === "qwen3-coder-plus")).toBe(true);
  });

  test("live labels drop vendor tags like [ModelScope]", () => {
    expect(modelLabel("qwen", null, live)).toBeNull();
    expect(modelLabel("qwen", "Qwen/Qwen3.5-397B-A17B", live)).toBe("Qwen/Qwen3.5-397B-A17B");
  });

  test("composer trigger stays compact: agent only on default, short model otherwise", () => {
    expect(triggerModelLabel("qwen", null, live)).toBeNull();
    expect(triggerModelLabel("qwen", "Qwen-Ambassador/Qwen3.8-Max", live)).toBe("Qwen3.8-Max");
    expect(compactModelLabel("[ModelScope] Qwen-Ambassador/Qwen3.8-Max")).toBe("Qwen3.8-Max");
    expect(compactModelLabel("Fable 5")).toBe("Fable 5");
  });
});
