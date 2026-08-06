import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterSource,
  type ProviderAdapter,
} from "@divisio/contracts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { CursorAdapter } from "./cursor.ts";
import { GrokAdapter } from "./grok.ts";
import { OpenCodeAdapter } from "./opencode.ts";
import { QwenAdapter } from "./qwen.ts";

export type { AdapterSource };

export interface RegisteredAdapter {
  adapter: ProviderAdapter;
  source: AdapterSource;
}

/**
 * Adapter registry. Orchestration resolves providers through here and never
 * branches on `kind` except for display metadata.
 *
 * First-party (builtin) defaults stay P0+P1 only. Community adapters register
 * via `loadCommunityAdapters` with `source: "community"`.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();

  constructor(
    adapters: ProviderAdapter[] = [
      new ClaudeAdapter(),
      new CodexAdapter(),
      new CursorAdapter(),
      new GrokAdapter(),
      new QwenAdapter(),
      new OpenCodeAdapter(),
    ],
  ) {
    for (const a of adapters) this.register(a, { source: "builtin" });
  }

  register(adapter: ProviderAdapter, opts: { source?: AdapterSource } = {}) {
    // Version check runs at load, not at first use — a mismatched community
    // adapter should fail loudly on startup, not mid-turn.
    if (adapter.contractVersion !== ADAPTER_CONTRACT_VERSION) {
      throw new Error(
        `adapter ${adapter.kind} targets contract v${adapter.contractVersion}, daemon is v${ADAPTER_CONTRACT_VERSION}`,
      );
    }
    this.adapters.set(adapter.kind, {
      adapter,
      source: opts.source ?? "builtin",
    });
  }

  get(kind: string): ProviderAdapter | null {
    return this.adapters.get(kind)?.adapter ?? null;
  }

  sourceOf(kind: string): AdapterSource | null {
    return this.adapters.get(kind)?.source ?? null;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()].map((e) => e.adapter);
  }

  listEntries(): RegisteredAdapter[] {
    return [...this.adapters.values()];
  }
}
