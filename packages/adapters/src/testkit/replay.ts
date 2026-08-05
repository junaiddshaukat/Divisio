/**
 * Adapter testkit — replay recorded vendor output against normalizers.
 *
 * Pattern borrowed from T3's mock-peer tests: CI never talks to a live CLI.
 * Fixtures are NDJSON (one vendor event per line), matching Claude's
 * `--output-format stream-json` and similar stream-tier transports.
 */

import { readFileSync } from "node:fs";
import type { ProviderRuntimeEvent } from "@divisio/contracts";
import {
  normalizeClaudeStreamLine,
  type ClaudeNormalizeState,
} from "../claude/normalize.ts";

export interface ReplayResult {
  events: ProviderRuntimeEvent[];
  /** Concatenated assistant text from delta-producing lines. */
  assistantText: string;
  state: ClaudeNormalizeState;
  /** Lines that were not valid JSON (should stay empty for golden fixtures). */
  unparseable: string[];
}

export type StreamNormalizer = (
  msg: Record<string, unknown>,
  turnId: string,
  state: ClaudeNormalizeState,
) => {
  events: ProviderRuntimeEvent[];
  text: string;
  state: ClaudeNormalizeState;
};

/** Split an NDJSON blob into non-empty trimmed lines. */
export function splitNdjson(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Replays NDJSON through a normalizer. Pure — no process spawn.
 */
export function replayNdjson(
  raw: string,
  turnId: string,
  normalize: StreamNormalizer = normalizeClaudeStreamLine,
  initial: ClaudeNormalizeState = { nativeId: null },
): ReplayResult {
  const events: ProviderRuntimeEvent[] = [];
  const unparseable: string[] = [];
  let assistantText = "";
  let state = initial;

  for (const line of splitNdjson(raw)) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unparseable.push(line.slice(0, 120));
      continue;
    }
    const result = normalize(msg, turnId, state);
    state = result.state;
    assistantText += result.text;
    events.push(...result.events);
  }

  return { events, assistantText, state, unparseable };
}

/** Load a fixture file from disk and replay it. */
export function replayFixtureFile(
  path: string,
  turnId: string,
  normalize?: StreamNormalizer,
): ReplayResult {
  return replayNdjson(readFileSync(path, "utf8"), turnId, normalize);
}
