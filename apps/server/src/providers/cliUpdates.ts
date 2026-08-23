import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderUpdate } from "@divisio/contracts";
import { PROVIDER_SETUP } from "@divisio/adapters/setup";
import { logger } from "@divisio/shared/log";
import { userDataDir } from "@divisio/shared/paths";
import { spawnWithEnv, terminateSubprocess } from "@divisio/shared/spawn";

const log = logger("cli-updates");

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const VIEW_TIMEOUT_MS = 8000;

/**
 * npm package names we can honestly compare. Curl-installed CLIs (Cursor,
 * Antigravity) are omitted — there is no version API we trust.
 */
export const NPM_UPDATE_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  grok: "@vibe-kit/grok-cli",
  qwen: "@qwen-code/qwen-code",
  gemini: "@google/gemini-cli",
  copilot: "@github/copilot",
  opencode: "opencode-ai",
};

export type UpdateProbe = {
  kind: string;
  label: string;
  available: boolean;
  version: string | null;
};

type LatestCache = {
  checkedAt: number;
  versions: Record<string, string>;
};

export function parseSemver(raw: string): [number, number, number] | null {
  const token = raw.trim().replace(/^v/i, "").split(/[\s+]/)[0] ?? "";
  const core = (token.split("-")[0] ?? "").trim();
  const m = core.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** True only when both parse and `latest` is strictly greater. Never guessed. */
export function isNewer(latest: string, installed: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(installed);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

export function extractInstalledVersion(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/i) ?? raw.match(/v?(\d+\.\d+)/i);
  if (match?.[1] && parseSemver(match[1])) return match[1].replace(/^v/i, "");
  return parseSemver(raw) ? raw.trim().replace(/^v/i, "").split(/[\s+]/)[0]! : null;
}

export function upgradeCommand(kind: string, pkg: string): string {
  const install = PROVIDER_SETUP[kind]?.install;
  if (install?.startsWith("npm ")) return `npm install -g ${pkg}@latest`;
  return install ?? `npm install -g ${pkg}@latest`;
}

export function updatesFromVersions(
  providers: UpdateProbe[],
  latestByPackage: Record<string, string>,
): ProviderUpdate[] {
  const out: ProviderUpdate[] = [];
  for (const p of providers) {
    if (!p.available) continue;
    const pkg = NPM_UPDATE_PACKAGES[p.kind];
    if (!pkg) continue;
    const installed = extractInstalledVersion(p.version);
    const latest = latestByPackage[pkg];
    if (!installed || !latest) continue;
    if (!isNewer(latest, installed)) continue;
    out.push({
      kind: p.kind,
      label: p.label,
      installed,
      latest,
      command: upgradeCommand(p.kind, pkg),
    });
  }
  return out;
}

function cacheFile(dir: string): string {
  return join(dir, "cli-latest.json");
}

async function readCache(dir: string): Promise<LatestCache | null> {
  try {
    const raw = await readFile(cacheFile(dir), "utf8");
    const parsed = JSON.parse(raw) as LatestCache;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.versions !== "object" || !parsed.versions) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(dir: string, cache: LatestCache): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(cacheFile(dir), JSON.stringify(cache), { mode: 0o600 });
}

function sanitizeNpmVersion(raw: string): string | null {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.toLowerCase().startsWith("npm "));
  const token = lines.at(-1) ?? "";
  return parseSemver(token) ? token.replace(/^v/i, "") : null;
}

async function npmViewVersion(pkg: string): Promise<string | null> {
  try {
    const proc = spawnWithEnv(["npm", "view", pkg, "version"], { stdout: "pipe", stderr: "pipe" });
    const raced = await Promise.race([
      (async () => {
        const out = await new Response(proc.stdout).text();
        const code = await proc.exited;
        return { out, code } as const;
      })(),
      Bun.sleep(VIEW_TIMEOUT_MS).then(() => "timeout" as const),
    ]);
    if (raced === "timeout") {
      await terminateSubprocess(proc, 400);
      return null;
    }
    if (raced.code !== 0) return null;
    return sanitizeNpmVersion(raced.out);
  } catch {
    return null;
  }
}

export async function collectCliUpdates(
  providers: UpdateProbe[],
  opts?: {
    cacheDir?: string;
    lookup?: (pkg: string) => Promise<string | null>;
  },
): Promise<ProviderUpdate[]> {
  const needed = [
    ...new Set(
      providers
        .filter((p) => p.available && NPM_UPDATE_PACKAGES[p.kind] && extractInstalledVersion(p.version))
        .map((p) => NPM_UPDATE_PACKAGES[p.kind]!),
    ),
  ];
  if (needed.length === 0) return [];

  const dir = opts?.cacheDir ?? userDataDir();
  const lookup = opts?.lookup ?? npmViewVersion;
  const cached = await readCache(dir);
  const fresh = cached && Date.now() - cached.checkedAt < CACHE_TTL_MS;
  if (fresh) return updatesFromVersions(providers, cached.versions);

  const versions: Record<string, string> = { ...(cached?.versions ?? {}) };
  const found = await Promise.all(
    needed.map(async (pkg) => {
      const latest = await lookup(pkg);
      return [pkg, latest] as const;
    }),
  );
  for (const [pkg, latest] of found) {
    if (latest) versions[pkg] = latest;
  }
  try {
    await writeCache(dir, { checkedAt: Date.now(), versions });
  } catch (err) {
    log.warn("cli latest cache write failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return updatesFromVersions(providers, versions);
}
