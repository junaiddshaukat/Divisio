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
