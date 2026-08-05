type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = RANK[(process.env.DIVISIO_LOG as Level) ?? "info"] ?? RANK.info;

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (RANK[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, scope, msg, ...fields };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(JSON.stringify(line));
}

/**
 * Scoped structured logger.
 *
 * Never log token values, prompt bodies, or full pairing URLs — see
 * docs/architecture/security.md.
 */
export function logger(scope: string) {
  return {
    debug: (msg: string, f?: Record<string, unknown>) => emit("debug", scope, msg, f),
    info: (msg: string, f?: Record<string, unknown>) => emit("info", scope, msg, f),
    warn: (msg: string, f?: Record<string, unknown>) => emit("warn", scope, msg, f),
    error: (msg: string, f?: Record<string, unknown>) => emit("error", scope, msg, f),
  };
}
