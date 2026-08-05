import { ADAPTER_CONTRACT_VERSION, type ProviderAdapter } from "@divisio/contracts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { CursorAdapter } from "./cursor.ts";

/**
 * Adapter registry. Orchestration resolves providers through here and never
 * branches on `kind` except for display metadata.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(
    adapters: ProviderAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new CursorAdapter()],
  ) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: ProviderAdapter) {
    // Version check runs at load, not at first use — a mismatched community
    // adapter should fail loudly on startup, not mid-turn.
    if (adapter.contractVersion !== ADAPTER_CONTRACT_VERSION) {
      throw new Error(
        `adapter ${adapter.kind} targets contract v${adapter.contractVersion}, daemon is v${ADAPTER_CONTRACT_VERSION}`,
      );
    }
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: string): ProviderAdapter | null {
    return this.adapters.get(kind) ?? null;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
