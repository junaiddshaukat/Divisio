/**
 * Host toolchain probes for Settings → Source Control.
 *
 * Reports what is on PATH for this daemon process — same PATH repair as
 * provider detection — so web and desktop share one answer.
 */

import type { ToolchainStatus, ToolchainToolStatus } from "@divisio/contracts";
import { spawnWithEnv } from "@divisio/shared/spawn";

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = spawnWithEnv(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = (await new Response(proc.stderr).text()).trim();
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (err) {
    return {
      code: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function firstLine(text: string): string | null {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  return line ?? null;
}

async function probeGit(): Promise<ToolchainToolStatus> {
  const ver = await run(["git", "--version"]);
  if (ver.code !== 0) {
    return {
      available: false,
      version: null,
      authenticated: null,
      detail: ver.stderr || "git not found on PATH",
    };
  }
  return {
    available: true,
    version: firstLine(ver.stdout) ?? "git",
    authenticated: null,
    detail: null,
  };
}

async function probeGh(): Promise<ToolchainToolStatus> {
  const ver = await run(["gh", "--version"]);
  if (ver.code !== 0) {
    return {
      available: false,
      version: null,
      authenticated: false,
      detail: ver.stderr || "gh not found on PATH",
    };
  }
  const version = firstLine(ver.stdout);
  const auth = await run(["gh", "auth", "status"]);
  const authOut = [auth.stdout, auth.stderr].filter(Boolean).join("\n");
  if (auth.code === 0) {
    const account =
      authOut
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /Logged in to|✓/i.test(l)) ?? null;
    return {
      available: true,
      version,
      authenticated: true,
      detail: account,
    };
  }
  return {
    available: true,
    version,
    authenticated: false,
    detail: firstLine(authOut) ?? "not authenticated — run gh auth login",
  };
}

export async function probeToolchain(): Promise<ToolchainStatus> {
  const [git, gh] = await Promise.all([probeGit(), probeGh()]);
  return { git, gh };
}
