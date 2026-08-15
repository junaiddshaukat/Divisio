import { OpenAICompatAdapter, type AdapterRegistry } from "@divisio/adapters";
import {
  customProviderKind,
  listCustomProviderRecords,
} from "./customProviders.ts";

/** (Re)register BYOK OpenAI-compatible adapters from userdata. */
export function syncCustomAdapters(registry: AdapterRegistry): void {
  for (const entry of registry.listEntries()) {
    if (entry.adapter.kind.startsWith("custom_")) {
      registry.unregister(entry.adapter.kind);
    }
  }
  for (const rec of listCustomProviderRecords()) {
    registry.register(
      new OpenAICompatAdapter({
        kind: customProviderKind(rec.id),
        label: rec.label,
        baseUrl: rec.baseUrl,
        modelId: rec.modelId,
        apiKey: rec.apiKey,
      }),
      { source: "custom" },
    );
  }
}
