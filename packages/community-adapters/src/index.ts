/**
 * Reference community adapters for Divisio Phase 4 / P2 providers.
 *
 * Loaded with `source: "community"` — not first-party forever. Operators can
 * disable the pack by omitting `@divisio/community-adapters` from boot, or add
 * more packages via `DIVISIO_ADAPTER_MODULES` / userdata `adapters.json`.
 */

import type { ProviderAdapter } from "@divisio/contracts";
import { AntigravityAdapter } from "./antigravity.ts";
import { CopilotAdapter } from "./copilot.ts";
import { GeminiAdapter } from "./gemini.ts";

export { AntigravityAdapter } from "./antigravity.ts";
export { CopilotAdapter } from "./copilot.ts";
export { GeminiAdapter } from "./gemini.ts";
export { normalizeGeminiStreamLine } from "./gemini/normalize.ts";
export { normalizeCopilotStreamLine } from "./copilot/normalize.ts";
export { normalizeAntigravityStreamLine } from "./antigravity/normalize.ts";

/** Factory required by the community loader. */
export function createAdapters(): ProviderAdapter[] {
  return [new GeminiAdapter(), new CopilotAdapter(), new AntigravityAdapter()];
}
