import { describe, expect, test } from "bun:test";
import { parseCodexModelsCache } from "./modelsCache.ts";

describe("parseCodexModelsCache", () => {
  test("lifts visible slugs only", () => {
    const catalog = parseCodexModelsCache({
      models: [
        { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
        { slug: "hidden-one", display_name: "Hidden", visibility: "hidden" },
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
      ],
    });
    expect(catalog.source).toBe("live");
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-5.6-terra", "gpt-5.6-sol"]);
  });

  test("empty cache is none", () => {
    expect(parseCodexModelsCache({ models: [] }).source).toBe("none");
    expect(parseCodexModelsCache({}).source).toBe("none");
  });
});
