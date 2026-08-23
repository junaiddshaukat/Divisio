/**
 * Shared NDJSON pump for community stream adapters.
 */

import type { EmitRuntimeEvent, ProviderRuntimeEvent } from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import type { TurnProcess } from "@divisio/adapters";

const log = logger("community:stream");

/** Drop CSI color codes so a CLI crash is readable in the thread, not `[31m…[0m`. */
export function visibleCliText(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").trim();
}

export type LineNormalizer<S> = (
  msg: Record<string, unknown>,
  turnId: string,
  state: S,
) => { events: ProviderRuntimeEvent[]; text: string; state: S };

export async function pumpCommunityNdjson<S extends { nativeId: string | null }>(opts: {
  proc: TurnProcess;
  turnId: string;
  emit: EmitRuntimeEvent;
  failLabel: string;
  initialState: S;
  normalize: LineNormalizer<S>;
  onNativeId?(id: string | null): void;
  isCurrent(): boolean;
  clearProc(): void;
}): Promise<void> {
  let assistantText = "";
  let buffer = "";
  let state = opts.initialState;

  try {
    const reader = opts.proc.stdout.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          log.warn("unparseable stream line", { sample: trimmed.slice(0, 120) });
          continue;
        }
        const result = opts.normalize(msg, opts.turnId, state);
        state = result.state;
        if (state.nativeId) opts.onNativeId?.(state.nativeId);
        for (const event of result.events) opts.emit(event);
        assistantText += result.text;
      }
    }

    const code = await opts.proc.exited;
    const stderr = await new Response(opts.proc.stderr).text();

    if (code !== 0 && code !== null) {
      if (opts.isCurrent()) {
        opts.emit({
          type: "error",
          code: "provider_failed",
          message:
            visibleCliText(stderr).split("\n").slice(-3).join(" ") || `${opts.failLabel} exited ${code}`,
        });
      }
    } else if (assistantText.length > 0) {
      opts.emit({ type: "assistant.message", turnId: opts.turnId, text: assistantText });
    }
  } catch (err) {
    opts.emit({ type: "error", code: "stream_failed", message: String(err) });
  } finally {
    if (opts.isCurrent()) {
      opts.clearProc();
      opts.emit({ type: "turn.completed", turnId: opts.turnId });
      opts.emit({ type: "status", status: "ready" });
    }
  }
}
