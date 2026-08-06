/**
 * Shared NDJSON stream pump helpers for Claude-like stream-json CLIs
 * (Claude, Qwen, Grok Messages wire format).
 */

import type { EmitRuntimeEvent, ProviderRuntimeEvent } from "@divisio/contracts";
import { logger } from "@divisio/shared/log";
import { spawnWithEnv } from "@divisio/shared/spawn";
import type { DetectResult } from "@divisio/contracts";
import {
  normalizeClaudeStreamLine,
  type ClaudeNormalizeState,
} from "../claude/normalize.ts";

const log = logger("adapter:stream");

type TurnProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

export async function detectCli(
  binary: string,
  versionArgs: string[],
  missingHint: string,
  failHint: string,
): Promise<DetectResult> {
  try {
    const proc = spawnWithEnv([binary, ...versionArgs], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      return { available: false, version: null, detail: failHint };
    }
    const raw = out.trim() || err.trim();
    const version = raw ? (raw.split(/\s+/).pop() ?? raw) : null;
    return { available: true, version, detail: null };
  } catch {
    return { available: false, version: null, detail: missingHint };
  }
}

export async function pumpClaudeLikeStream(opts: {
  proc: TurnProcess;
  turnId: string;
  emit: EmitRuntimeEvent;
  getNativeId(): string | null;
  setNativeId(id: string | null): void;
  isCurrent(): boolean;
  clearProc(): void;
  failLabel: string;
}): Promise<void> {
  let assistantText = "";
  let buffer = "";
  let normState: ClaudeNormalizeState = { nativeId: opts.getNativeId() };

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
        const result = normalizeClaudeStreamLine(msg, opts.turnId, normState);
        normState = result.state;
        if (normState.nativeId) opts.setNativeId(normState.nativeId);
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
          message: stderr.trim().split("\n").slice(-3).join(" ") || `${opts.failLabel} exited ${code}`,
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

export async function interruptProcess(
  proc: TurnProcess,
  emit: EmitRuntimeEvent,
  turnId: string,
): Promise<void> {
  emit({ type: "status", status: "stopping" });
  proc.kill("SIGTERM");
  const deadline = Bun.sleep(2000).then(() => "timeout" as const);
  const exited = proc.exited.then(() => "exited" as const);
  if ((await Promise.race([exited, deadline])) === "timeout") {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  emit({ type: "turn.completed", turnId });
  emit({ type: "status", status: "ready" });
}

export type { TurnProcess, ProviderRuntimeEvent };
