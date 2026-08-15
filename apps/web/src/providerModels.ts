/**
 * Curated model / option lists for the composer AgentPicker.
 *
 * Used when an adapter cannot list live models (`provider.models` returns
 * `source: "none"`). Live catalogs from the vendor CLI replace this list
 * for that provider — they are what the user actually has configured.
 *
 * These are CLI aliases we pass through `--model` (or equivalent), not a
 * Divisio-owned catalog. "Default" means omit the flag and let the CLI choose.
 */

import type { ModelCatalog } from "@divisio/contracts";

export interface ProviderModelOption {
  id: string;
  label: string;
  /** When true, do not pass --model to the CLI. */
  isDefault?: boolean;
}

const DEFAULT: ProviderModelOption = { id: "default", label: "Default (CLI)", isDefault: true };

const CATALOG: Record<string, ProviderModelOption[]> = {
  claude: [
    DEFAULT,
    { id: "best", label: "Best (Fable 5 / latest)" },
    { id: "fable", label: "Fable 5" },
    { id: "opus", label: "Opus (latest)" },
    { id: "sonnet", label: "Sonnet (latest)" },
    { id: "haiku", label: "Haiku (latest)" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "opus[1m]", label: "Opus (1M context)" },
    { id: "sonnet[1m]", label: "Sonnet (1M context)" },
    { id: "fable[1m]", label: "Fable 5 (1M context)" },
  ],
  cursor: [
    DEFAULT,
    { id: "auto", label: "Auto" },
    { id: "composer-2", label: "Composer 2" },
    { id: "composer-1.5", label: "Composer 1.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-medium-fast", label: "GPT-5.4 Fast" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-4.6-sonnet", label: "Claude Sonnet 4.6 (alias)" },
    { id: "claude-4.6-opus-high-thinking", label: "Claude Opus 4.6 Thinking" },
  ],
  codex: [
    DEFAULT,
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.6", label: "GPT-5.6" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "o3", label: "o3" },
  ],
  grok: [
    DEFAULT,
    { id: "grok-4.5", label: "Grok 4.5" },
    { id: "grok-build", label: "Grok Build" },
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-3", label: "Grok 3" },
  ],
  qwen: [
    DEFAULT,
    { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
    { id: "qwen3-coder-next", label: "Qwen3 Coder Next" },
    { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
    { id: "qwen3.6-plus", label: "Qwen3.6 Plus" },
    { id: "qwen3.5-plus", label: "Qwen3.5 Plus" },
    { id: "qwen3-max-2026-01-23", label: "Qwen3 Max" },
    { id: "glm-5", label: "GLM-5" },
    { id: "glm-4.7", label: "GLM-4.7" },
    { id: "kimi-k2.5", label: "Kimi K2.5" },
    { id: "MiniMax-M2.5", label: "MiniMax M2.5" },
  ],
  opencode: [
    DEFAULT,
    { id: "openai/gpt-5.4", label: "OpenAI GPT-5.4" },
    { id: "openai/gpt-5.2", label: "OpenAI GPT-5.2" },
    { id: "openai/gpt-5", label: "OpenAI GPT-5" },
    { id: "opencode/gpt-5.1-codex", label: "OpenCode GPT-5.1 Codex" },
    { id: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (OpenRouter)" },
  ],
  gemini: [
    DEFAULT,
    { id: "auto", label: "Auto" },
    { id: "pro", label: "Pro" },
    { id: "flash", label: "Flash" },
    { id: "flash-lite", label: "Flash Lite" },
    { id: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  ],
  copilot: [
    DEFAULT,
    { id: "auto", label: "Auto" },
    { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "claude-opus-4.7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    { id: "mai-code-1-flash", label: "MAI Code 1 Flash" },
  ],
  antigravity: [
    DEFAULT,
    { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
    { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)" },
    { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)" },
    { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
    { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)" },
    { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6" },
    { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6" },
    { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B" },
  ],
};

/** Custom OpenAI-compatible endpoints use kind `custom_<id>`. */
const customModelCache = new Map<string, ProviderModelOption[]>();

export function setCustomProviderModels(kind: string, modelId: string, label?: string): void {
  customModelCache.set(kind, [
    { id: modelId, label: label ?? modelId },
  ]);
}

export function removeCustomProviderModels(kind: string): void {
  customModelCache.delete(kind);
}

export function modelsForProvider(kind: string, live?: ModelCatalog | null): ProviderModelOption[] {
  if (kind.startsWith("custom_")) {
    return customModelCache.get(kind) ?? [DEFAULT];
  }
  const curated = CATALOG[kind] ?? [DEFAULT];
  if (!live || live.source !== "live" || live.models.length === 0) return curated;

  const seen = new Set<string>(["default"]);
  const out: ProviderModelOption[] = [DEFAULT];
  for (const m of live.models) {
    const id = m.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.label.trim() || id });
  }
  return out;
}

export function modelLabel(
  kind: string,
  modelId: string | null | undefined,
  live?: ModelCatalog | null,
): string | null {
  if (!modelId || modelId === "default") {
    if (live?.source === "live" && live.selectedId) {
      const hit = modelsForProvider(kind, live).find((m) => m.id === live.selectedId);
      return hit?.label ?? live.selectedId;
    }
    return null;
  }
  return modelsForProvider(kind, live).find((m) => m.id === modelId)?.label ?? modelId;
}
