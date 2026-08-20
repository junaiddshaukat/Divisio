/**
 * Process spawning that honours the daemon's repaired PATH.
 *
 * `Bun.spawn` resolves the executable against the environment the process
 * started with, not against later mutations of `process.env`. A GUI-launched
 * daemon repairs its PATH at startup (see path-env.ts), so a spawn that omits
 * `env` looks up binaries in launchd's minimal PATH and reports every agent CLI
 * as missing — while `command -v` in a terminal finds them fine.
 *
 * Use this for anything resolved by name: provider CLIs, git, gh, shells.
 */

type Writable = Bun.SpawnOptions.Writable;
type Readable = Bun.SpawnOptions.Readable;

/**
 * Spawns with the current `process.env` merged in, preserving Bun's stdio
 * generics so `proc.stdout` stays a stream rather than widening to unknown.
 */
export function spawnWithEnv<
  In extends Writable = "ignore",
  Out extends Readable = "pipe",
  Err extends Readable = "inherit",
>(
  cmd: string[],
  options?: Bun.SpawnOptions.OptionsObject<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
  return Bun.spawn(cmd, {
    ...(options ?? {}),
    env: { ...(process.env as Record<string, string>), ...(options?.env ?? {}) },
  } as Bun.SpawnOptions.OptionsObject<In, Out, Err>);
}

async function childPids(parent: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(parent)], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return [];
    return out
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return [];
  }
}

/** Direct children, then theirs — never includes `root`. */
async function descendants(root: number): Promise<number[]> {
  const found: number[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const child of await childPids(id)) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * SIGTERM/SIGKILL the process and every descendant we can see.
 * `kill(-pid)` is unsafe here: provider CLIs share the daemon's process
 * group unless they daemonize, and that would take the daemon down too.
 */
export async function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
  if (pid == null || pid <= 1) return;
  if (process.platform === "win32") {
    signalPid(pid, signal);
    return;
  }
  const kids = await descendants(pid);
  for (const p of [...kids].reverse()) signalPid(p, signal);
  signalPid(pid, signal);
}

type KillableProc = {
  pid?: number;
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number | null>;
};

/** SIGTERM the tree, then SIGKILL if it is still alive after `graceMs`. */
export async function terminateSubprocess(proc: KillableProc, graceMs = 2000): Promise<void> {
  const pid = proc.pid;
  await killProcessTree(pid, "SIGTERM");
  try {
    proc.kill("SIGTERM");
  } catch {
    /* gone */
  }
  const raced = await Promise.race([
    proc.exited.then(() => "exited" as const),
    Bun.sleep(graceMs).then(() => "timeout" as const),
  ]);
  if (raced === "timeout") {
    await killProcessTree(pid, "SIGKILL");
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    await proc.exited.catch(() => {});
  }
}
