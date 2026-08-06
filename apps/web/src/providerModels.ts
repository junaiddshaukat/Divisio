/**
 * Curated model / option lists for the composer AgentPicker.
 *
 * These are CLI aliases we pass through `--model` (or equivalent), not a
 * Divisio-owned catalog. "Default" means omit the flag and let the CLI choose.
 */

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
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  cursor: [
    DEFAULT,
    { id: "composer-2", label: "Composer 2" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "claude-4.6-sonnet", label: "Claude Sonnet 4.6" },
  ],
  codex: [
    DEFAULT,
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "o3", label: "o3" },
  ],
  grok: [
    DEFAULT,
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-3", label: "Grok 3" },
  ],
  qwen: [DEFAULT, { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" }],
  opencode: [DEFAULT],
  gemini: [
    DEFAULT,
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  copilot: [DEFAULT],
  antigravity: [
    DEFAULT,
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ],
};

export function modelsForProvider(kind: string): ProviderModelOption[] {
  return CATALOG[kind] ?? [DEFAULT];
}

export function modelLabel(kind: string, modelId: string | null | undefined): string | null {
  if (!modelId || modelId === "default") return null;
  return modelsForProvider(kind).find((m) => m.id === modelId)?.label ?? modelId;
}
