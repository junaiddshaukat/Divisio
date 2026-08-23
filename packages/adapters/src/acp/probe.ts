/**
 * Cheap check for whether a CLI can act as an ACP agent.
 *
 * Adapters gate their declared capabilities on this: an agent that speaks ACP
 * can mediate approvals, one that does not cannot, and claiming otherwise puts
 * a control in the UI that decides nothing.
 *
 * The probe starts the agent, completes a handshake, and kills it. Results are
 * cached because it runs on the provider-detect fan-out, which the UI calls on
 * every load.
 */

import { logger } from "@divisio/shared/log";
import { ACP_PROTOCOL_VERSION } from "./session.ts";

const log = logger("adapter:acp");

/**
 * Handshake budget.
 *
 * Generous on purpose: a signed-in agent may do auth and network work before
 * answering, which has been measured at 7-9s, while an agent that does not
 * speak the protocol fails in milliseconds. Timing out early would report a
 * capable agent as incapable — the one error this probe must not make.
 */
const PROBE_TIMEOUT_MS = 20_000;

/** Support does not change while the daemon runs, short of a CLI upgrade. */
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; supported: boolean }>();
/** In-flight probes, so a detect fan-out cannot start several at once. */
const inFlight = new Map<string, Promise<boolean>>();

/** Clears memoized probe results. Exposed for tests. */
export function resetAcpProbeCache(): void {
  cache.clear();
  inFlight.clear();
}

export async function probeAcpSupport(cmd: string[], cwd?: string): Promise<boolean> {
  const key = cmd.join(" ");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.supported;

  const running = inFlight.get(key);
  if (running) return await running;

  const task = runProbe(cmd, cwd).then((supported) => {
    cache.set(key, { at: Date.now(), supported });
    inFlight.delete(key);
    return supported;
  });
  inFlight.set(key, task);
  return await task;
}

/**
 * Last known answer without starting a probe.
 *
 * `detect()` runs on a fan-out across every adapter each time the UI loads, so
 * it must not block on a handshake that can take seconds. Callers report what
 * is already known and let `refreshAcpSupport` settle the real answer.
 */
export function cachedAcpSupport(cmd: string[]): boolean | null {
  const hit = cache.get(cmd.join(" "));
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_TTL_MS) return null;
  return hit.supported;
}

/** Start a probe in the background if one is not already running or cached. */
export function refreshAcpSupport(cmd: string[], cwd?: string): void {
  if (cachedAcpSupport(cmd) !== null) return;
  if (inFlight.has(cmd.join(" "))) return;
  void probeAcpSupport(cmd, cwd).catch(() => undefined);
}

async function runProbe(cmd: string[], cwd?: string): Promise<boolean> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  try {
    proc = Bun.spawn({
      cmd,
      ...(cwd ? { cwd } : {}),
      env: { ...(process.env as Record<string, string>) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const child = proc;

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        },
      })}\n`,
    );
    child.stdin.flush();

    const answered = readFirstFrame(child);
    const timed = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS));
    return await Promise.race([answered, timed]);
  } catch (err) {
    log.debug("acp probe failed to start", { cmd: cmd.join(" "), detail: String(err) });
    return false;
  } finally {
    proc?.kill();
  }
}

/** True when the first frame is a JSON-RPC result carrying a protocol version. */
async function readFirstFrame(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<boolean> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { result?: { protocolVersion?: unknown } };
          return typeof msg.result?.protocolVersion === "number";
        } catch {
          // A non-JSON banner line means this is not an ACP stream.
          return false;
        }
      }
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}
