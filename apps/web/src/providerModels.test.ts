import { describe, expect, test } from "bun:test";
import { modelLabel, modelsForProvider } from "./providerModels.ts";
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

  test("empty-thread trigger shows the CLI's selected live label", () => {
    expect(modelLabel("qwen", null, live)).toBe("[ModelScope] Qwen-Ambassador/Qwen3.8-Max");
    expect(modelLabel("qwen", "Qwen/Qwen3.5-397B-A17B", live)).toBe(
      "[ModelScope] Qwen/Qwen3.5-397B-A17B",
    );
  });
});
