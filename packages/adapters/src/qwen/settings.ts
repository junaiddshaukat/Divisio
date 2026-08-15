/**
 * Qwen Code stores the user's model list in `$QWEN_HOME/settings.json`
 * (default `~/.qwen/settings.json`). That file is also how ModelScope /
 * Ambassador custom models appear in other command centers — they do not
 * invent the names; they pass through what Qwen already configured.
 *
 * We only lift `id` and display `name`. Env keys, tokens, and base URLs stay
 * in the file.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelOption } from "@divisio/contracts";
import { EMPTY_MODEL_CATALOG, readJsonUnknown } from "../shared/modelCatalog.ts";

export function qwenSettingsPath(): string {
  const home = process.env.QWEN_HOME?.trim();
  return join(home && home.length > 0 ? home : join(homedir(), ".qwen"), "settings.json");
}

export function parseQwenSettings(raw: unknown): ModelCatalog {
  if (!raw || typeof raw !== "object") return EMPTY_MODEL_CATALOG;
  const obj = raw as Record<string, unknown>;
  const models: ModelOption[] = [];
  const seen = new Set<string>();

  const groups = obj.modelProviders;
  if (groups && typeof groups === "object" && !Array.isArray(groups)) {
    for (const group of Object.values(groups as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const entry of group) {
        const opt = optionFromEntry(entry);
        if (!opt || seen.has(opt.id)) continue;
        seen.add(opt.id);
        models.push(opt);
      }
    }
  }

  let selectedId: string | null = null;
  const current = obj.model;
  if (current && typeof current === "object") {
    const rec = current as Record<string, unknown>;
    if (typeof rec.name === "string" && rec.name.trim()) selectedId = rec.name.trim();
    else if (typeof rec.id === "string" && rec.id.trim()) selectedId = rec.id.trim();
  }

  if (selectedId && !seen.has(selectedId)) {
    models.unshift({ id: selectedId, label: selectedId });
  }

  if (models.length === 0) return { ...EMPTY_MODEL_CATALOG, selectedId };
  return { source: "live", models, selectedId };
}

function optionFromEntry(entry: unknown): ModelOption | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  const label = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
  return { id, label };
}

export async function readQwenModelCatalog(): Promise<ModelCatalog> {
  const raw = await readJsonUnknown(qwenSettingsPath());
  if (raw === null) return EMPTY_MODEL_CATALOG;
  return parseQwenSettings(raw);
}
