import type { ModelCatalog } from "@divisio/contracts";

export const EMPTY_MODEL_CATALOG: ModelCatalog = { source: "none", models: [] };

/** Read a JSON file as unknown. Missing or unreadable → null. Never throws. */
export async function readJsonUnknown(path: string): Promise<unknown | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch {
    return null;
  }
}
