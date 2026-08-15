/**
 * Persist BYOK OpenAI-compatible endpoints under userdata (owner-only).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureUserDataDir, userDataDir } from "@divisio/shared/paths";

export interface CustomProviderRecord {
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomProviderView {
  id: string;
  kind: string;
  label: string;
  baseUrl: string;
  modelId: string;
  /** Masked key for UI — never the raw secret. */
  apiKeyPreview: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoreFile {
  providers: CustomProviderRecord[];
}

export function customProviderKind(id: string): string {
  return `custom_${id}`;
}

export function isCustomProviderKind(kind: string): boolean {
  return kind.startsWith("custom_");
}

function storePath(): string {
  return join(userDataDir(), "custom-providers.json");
}

function maskKey(key: string): string {
  const t = key.trim();
  if (t.length <= 8) return "••••";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function toView(r: CustomProviderRecord): CustomProviderView {
  return {
    id: r.id,
    kind: customProviderKind(r.id),
    label: r.label,
    baseUrl: r.baseUrl,
    modelId: r.modelId,
    apiKeyPreview: maskKey(r.apiKey),
    hasApiKey: r.apiKey.trim().length > 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function readStore(): StoreFile {
  const path = storePath();
  if (!existsSync(path)) return { providers: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    return { providers: Array.isArray(raw.providers) ? raw.providers : [] };
  } catch {
    return { providers: [] };
  }
}

function writeStore(file: StoreFile): void {
  ensureUserDataDir();
  const path = storePath();
  mkdirSync(userDataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms that ignore mode */
  }
}

export function listCustomProviders(): CustomProviderView[] {
  return readStore().providers.map(toView);
}

export function listCustomProviderRecords(): CustomProviderRecord[] {
  return readStore().providers;
}

export function getCustomProviderRecord(id: string): CustomProviderRecord | null {
  return readStore().providers.find((p) => p.id === id) ?? null;
}

export function upsertCustomProvider(input: {
  id?: string;
  label: string;
  baseUrl: string;
  modelId: string;
  /** Omit or empty to keep the existing key when updating. */
  apiKey?: string;
}): CustomProviderView {
  const label = input.label.trim();
  const baseUrl = input.baseUrl.trim();
  const modelId = input.modelId.trim();
  if (!label) throw new Error("label is required");
  if (!baseUrl) throw new Error("base URL is required");
  if (!modelId) throw new Error("model id is required");
  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    throw new Error("base URL must be a valid URL");
  }

  const file = readStore();
  const now = new Date().toISOString();
  const existing = input.id ? file.providers.find((p) => p.id === input.id) : undefined;
  const apiKey = (input.apiKey ?? "").trim() || existing?.apiKey || "";
  if (!apiKey) throw new Error("API key is required");

  if (existing) {
    existing.label = label;
    existing.baseUrl = baseUrl;
    existing.modelId = modelId;
    existing.apiKey = apiKey;
    existing.updatedAt = now;
    writeStore(file);
    return toView(existing);
  }

  const record: CustomProviderRecord = {
    id: input.id?.trim() || randomUUID().replaceAll("-", "").slice(0, 12),
    label,
    baseUrl,
    modelId,
    apiKey,
    createdAt: now,
    updatedAt: now,
  };
  file.providers.push(record);
  writeStore(file);
  return toView(record);
}

export function deleteCustomProvider(id: string): boolean {
  const file = readStore();
  const next = file.providers.filter((p) => p.id !== id);
  if (next.length === file.providers.length) return false;
  writeStore({ providers: next });
  return true;
}
