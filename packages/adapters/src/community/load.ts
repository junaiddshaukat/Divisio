/**
 * Community adapter loader (Phase 4).
 *
 * Trust boundary: only modules the operator opted into (env, adapters.json, or
 * the shipped reference community pack). Never auto-downloads packages.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter } from "@divisio/contracts";
import { ENV_PREFIX } from "@divisio/shared/brand";
import { logger } from "@divisio/shared/log";
import { userDataDir } from "@divisio/shared/paths";
import type { AdapterRegistry } from "../registry.ts";

const log = logger("adapters:community");

export interface CommunityAdaptersConfig {
  /** Module specifiers that export `createAdapter` or `createAdapters`. */
  modules?: string[];
}

export interface LoadCommunityOptions {
  registry: AdapterRegistry;
  /** Always-on reference pack (workspace / published). */
  builtinModules?: string[];
  /** Override path to adapters.json (defaults to userdata/adapters.json). */
  configPath?: string;
  /** Override env module list (defaults to DIVISIO_ADAPTER_MODULES). */
  envModules?: string[];
}

type CommunityModule = {
  createAdapter?: () => ProviderAdapter;
  createAdapters?: () => ProviderAdapter[];
  default?: CommunityModule;
};

function parseEnvModules(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readAdaptersConfig(configPath: string): CommunityAdaptersConfig {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as CommunityAdaptersConfig;
    return {
      modules: Array.isArray(parsed.modules)
        ? parsed.modules.filter((m): m is string => typeof m === "string")
        : [],
    };
  } catch (err) {
    log.warn("failed to read adapters.json", { configPath, err: String(err) });
    return {};
  }
}

export function defaultAdaptersConfigPath(): string {
  return join(userDataDir(), "adapters.json");
}

async function importCommunityModule(specifier: string): Promise<CommunityModule> {
  const mod = (await import(specifier)) as CommunityModule;
  return mod.default && typeof mod.default === "object" ? { ...mod, ...mod.default } : mod;
}

function adaptersFromModule(mod: CommunityModule, specifier: string): ProviderAdapter[] {
  if (typeof mod.createAdapters === "function") {
    const list = mod.createAdapters();
    if (!Array.isArray(list)) {
      throw new Error(`${specifier}: createAdapters() must return ProviderAdapter[]`);
    }
    return list;
  }
  if (typeof mod.createAdapter === "function") {
    return [mod.createAdapter()];
  }
  throw new Error(`${specifier}: export createAdapter() or createAdapters()`);
}

/**
 * Loads community adapters into the registry. Failures on individual modules
 * are logged; a hard contract mismatch still throws from `register`.
 */
export async function loadCommunityAdapters(opts: LoadCommunityOptions): Promise<{
  loaded: string[];
  failed: Array<{ module: string; error: string }>;
}> {
  const configPath = opts.configPath ?? defaultAdaptersConfigPath();
  const fromConfig = readAdaptersConfig(configPath).modules ?? [];
  const fromEnv =
    opts.envModules ??
    parseEnvModules(process.env[`${ENV_PREFIX}_ADAPTER_MODULES`]);
  const modules = [...new Set([...(opts.builtinModules ?? []), ...fromConfig, ...fromEnv])];

  const loaded: string[] = [];
  const failed: Array<{ module: string; error: string }> = [];

  for (const specifier of modules) {
    try {
      const mod = await importCommunityModule(specifier);
      const adapters = adaptersFromModule(mod, specifier);
      for (const adapter of adapters) {
        opts.registry.register(adapter, { source: "community" });
        loaded.push(adapter.kind);
        log.info("registered community adapter", { kind: adapter.kind, module: specifier });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ module: specifier, error: message });
      log.warn("community adapter load failed", { module: specifier, error: message });
    }
  }

  return { loaded, failed };
}
