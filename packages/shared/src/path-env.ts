import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./log.ts";

const log = logger("path");

/**
 * Repairs PATH for a GUI-launched daemon.
 *
 * A double-clicked macOS app inherits launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
 * — not the one from the user's shell profile. Every agent CLI installs somewhere
 * else (`~/.local/bin`, Homebrew, `~/.bun/bin`), so provider detection reports
 * "not on PATH" for tools that are plainly installed, and the app looks broken
 * while being technically correct.
 *
 * Two sources, cheapest first: well-known install directories, then the user's
 * login shell if it can be asked.
 */

/** Directories agent CLIs and package managers install into. */
function candidateDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
}

/**
 * Asks the login shell for its PATH.
 *
 * `-l` runs profile files, which is where version managers put their shims.
 * Bounded by a timeout: a misbehaving profile must not stall daemon startup.
 */
async function loginShellPath(timeoutMs = 2000): Promise<string | null> {
  const shell = process.env["SHELL"];
  if (!shell || process.platform === "win32") return null;

  try {
    const proc = Bun.spawn([shell, "-lc", "printf %s \"$PATH\""], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, DIVISIO_PATH_PROBE: "1" },
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);

    if (code !== 0 || !out.trim()) return null;
    return out.trim();
  } catch {
    return null;
  }
}

function merge(...paths: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of paths.join(":").split(":")) {
    const dir = entry.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(":");
}

/**
 * Augments `process.env.PATH` in place. Idempotent, and safe to call at startup
 * before anything spawns a provider.
 */
export async function repairPath(): Promise<string> {
  const original = process.env["PATH"] ?? "";
  const existing = new Set(original.split(":"));

  const additions = candidateDirs().filter((dir) => !existing.has(dir) && existExists(dir));
  const shellPath = await loginShellPath();

  const merged = merge(original, shellPath ?? "", ...additions);
  process.env["PATH"] = merged;

  const added = merged.split(":").filter((d) => !existing.has(d));
  if (added.length > 0) {
    // Worth a log line: when a provider is missing, this is the first thing to check.
    log.info("PATH extended for provider discovery", { added });
  }
  return merged;
}

function existExists(dir: string): boolean {
  try {
    return existsSync(dir);
  } catch {
    return false;
  }
}
