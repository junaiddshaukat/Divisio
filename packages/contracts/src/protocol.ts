import type { CommandName } from "./wire.ts";

/**
 * Daemon / client compatibility generation.
 *
 * Bump this integer in the SAME commit as any command, ready-frame field, or
 * health field the current UI or desktop shell requires. An older process
 * omits the field or reports a smaller number and must be refused — never
 * attached, never probed command-by-command until something 404s.
 *
 * Comparison is `advertised >= DAEMON_GENERATION`: a newer daemon may talk
 * to an older UI. The reverse is incompatible.
 *
 * Desktop attach reads this from `/health`. Do not reintroduce a second
 * required-command list in the shell — bump this number instead.
 */
export const DAEMON_GENERATION = 1;

/**
 * Commands this generation of the UI needs. Documents what generation N
 * implies; desktop attach does not parse this list. The web client uses it
 * as a second check when a daemon claims a generation but forgot to advertise.
 */
export const REQUIRED_COMMANDS: readonly CommandName[] = [
  "project.list",
  "thread.create",
  "thread.setProvider",
  "turn.send",
  "turn.restore",
  "project.remove",
  "file.tree",
  "file.read",
  "terminal.open",
];

export interface DaemonIncompatibility {
  /** Advertised generation, or null when the daemon predates this field. */
  have: number | null;
  need: number;
  missing: CommandName[];
}

export function daemonGenerationOf(input: { generation?: unknown }): number | null {
  return typeof input.generation === "number" && Number.isInteger(input.generation) && input.generation >= 0
    ? input.generation
    : null;
}

function advertisedCommands(commands: unknown): string[] | undefined {
  if (!Array.isArray(commands)) return undefined;
  return commands.filter((c): c is string => typeof c === "string");
}

export function missingRequiredCommands(commands: readonly string[] | undefined): CommandName[] {
  if (!commands) return [...REQUIRED_COMMANDS];
  const advertised = new Set(commands);
  return REQUIRED_COMMANDS.filter((c) => !advertised.has(c));
}

/**
 * Null when this app can use the daemon. A missing generation is always a
 * miss — command names in a JSON blob are not a substitute (substring
 * matching on `/health` is how an old process used to get adopted).
 */
export function incompatibilityOf(advertised: {
  generation?: unknown;
  commands?: unknown;
}): DaemonIncompatibility | null {
  const have = daemonGenerationOf(advertised);
  const missing = missingRequiredCommands(advertisedCommands(advertised.commands));
  if (have !== null && have >= DAEMON_GENERATION && missing.length === 0) return null;
  return { have, need: DAEMON_GENERATION, missing };
}
