/**
 * Codex caches the account model list at `$CODEX_HOME/models_cache.json`
 * (default `~/.codex/models_cache.json`). Reading the cache is side-effect-free
 * and does not start a login. We only lift slug + display name.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelOption } from "@divisio/contracts";
import { EMPTY_MODEL_CATALOG, readJsonUnknown } from "../shared/modelCatalog.ts";

export function codexModelsCachePath(): string {
  const home = process.env.CODEX_HOME?.trim();
  return join(home && home.length > 0 ? home : join(homedir(), ".codex"), "models_cache.json");
}

export function parseCodexModelsCache(raw: unknown): ModelCatalog {
  if (!raw || typeof raw !== "object") return EMPTY_MODEL_CATALOG;
  const list = (raw as { models?: unknown }).models;
  if (!Array.isArray(list)) return EMPTY_MODEL_CATALOG;

  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.visibility === "hidden") continue;
    const id = typeof rec.slug === "string" ? rec.slug.trim() : "";
    if (!id || seen.has(id)) continue;
    const label =
      typeof rec.display_name === "string" && rec.display_name.trim() ? rec.display_name.trim() : id;
    seen.add(id);
    models.push({ id, label });
  }

  if (models.length === 0) return EMPTY_MODEL_CATALOG;
  return { source: "live", models };
}

export async function readCodexModelCatalog(): Promise<ModelCatalog> {
  const raw = await readJsonUnknown(codexModelsCachePath());
  if (raw === null) return EMPTY_MODEL_CATALOG;
  return parseCodexModelsCache(raw);
}
