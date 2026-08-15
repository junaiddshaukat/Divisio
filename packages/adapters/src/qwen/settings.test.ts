import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQwenSettings, readQwenModelCatalog } from "./settings.ts";

const fixture = {
  env: { MODELSCOPE_API_KEY: "secret-must-not-leak" },
  modelProviders: {
    openai: [
      {
        id: "Qwen-Ambassador/Qwen3.8-Max",
        name: "[ModelScope] Qwen-Ambassador/Qwen3.8-Max",
        envKey: "MODELSCOPE_API_KEY",
        baseUrl: "https://example.invalid",
      },
      {
        id: "Qwen/Qwen3.5-397B-A17B",
        name: "[ModelScope] Qwen/Qwen3.5-397B-A17B",
      },
    ],
  },
  model: { name: "Qwen-Ambassador/Qwen3.8-Max" },
};

describe("parseQwenSettings", () => {
  test("lifts ModelScope ids and labels, never secrets", () => {
    const catalog = parseQwenSettings(fixture);
    expect(catalog.source).toBe("live");
    expect(catalog.selectedId).toBe("Qwen-Ambassador/Qwen3.8-Max");
    expect(catalog.models).toEqual([
      { id: "Qwen-Ambassador/Qwen3.8-Max", label: "[ModelScope] Qwen-Ambassador/Qwen3.8-Max" },
      { id: "Qwen/Qwen3.5-397B-A17B", label: "[ModelScope] Qwen/Qwen3.5-397B-A17B" },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("secret-must-not-leak");
    expect(JSON.stringify(catalog)).not.toContain("MODELSCOPE_API_KEY");
    expect(JSON.stringify(catalog)).not.toContain("example.invalid");
  });

  test("empty or junk input is none", () => {
    expect(parseQwenSettings(null).source).toBe("none");
    expect(parseQwenSettings({}).source).toBe("none");
    expect(parseQwenSettings("nope").source).toBe("none");
  });

  test("selected id not in providers is still listed", () => {
    const catalog = parseQwenSettings({ model: { name: "local/custom" } });
    expect(catalog.models[0]).toEqual({ id: "local/custom", label: "local/custom" });
  });

  test("readQwenModelCatalog follows QWEN_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "divisio-qwen-"));
    const prev = process.env.QWEN_HOME;
    await writeFile(join(dir, "settings.json"), JSON.stringify(fixture));
    process.env.QWEN_HOME = dir;
    try {
      const catalog = await readQwenModelCatalog();
      expect(catalog.source).toBe("live");
      expect(catalog.models[0]?.id).toBe("Qwen-Ambassador/Qwen3.8-Max");
      expect(JSON.stringify(catalog)).not.toContain("secret-must-not-leak");
    } finally {
      if (prev === undefined) delete process.env.QWEN_HOME;
      else process.env.QWEN_HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
