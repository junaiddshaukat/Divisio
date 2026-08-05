import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DB_FILENAME, ENV_PREFIX, HOME_DIR_NAME } from "./brand.ts";

/**
 * Resolves the daemon home directory.
 *
 * Override with DIVISIO_HOME. Worktree-local homes matter more than they look:
 * without them an agent working in this repo shares live state with the human
 * running the app, and they corrupt each other's sessions.
 */
export function resolveHome(): string {
  const override = process.env[`${ENV_PREFIX}_HOME`];
  return override && override.length > 0 ? override : join(homedir(), HOME_DIR_NAME);
}

export function userDataDir(home = resolveHome()): string {
  return join(home, "userdata");
}

export function dbPath(home = resolveHome()): string {
  return join(userDataDir(home), DB_FILENAME);
}

export function tokenPath(home = resolveHome()): string {
  return join(userDataDir(home), "auth-token");
}

/**
 * Creates the userdata directory with owner-only permissions.
 *
 * 0700 is not decoration: this directory holds the auth token that grants shell
 * execution on this machine. See docs/architecture/security.md.
 */
export function ensureUserDataDir(home = resolveHome()): string {
  const dir = userDataDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
