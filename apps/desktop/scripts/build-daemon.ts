/**
 * Compiles the daemon into a standalone binary for Tauri to bundle.
 *
 * Tauri's externalBin requires the target triple as a filename suffix and
 * resolves it at bundle time, so the name must match the host exactly.
 * Bundling this removes the "install Bun first" step, which is the difference
 * between a developer tool and something a user can actually install.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");

async function hostTriple(): Promise<string> {
  const proc = Bun.spawn(["rustc", "-vV"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("rustc not found — required to resolve the target triple");
  const host = out.split("\n").find((l) => l.startsWith("host:"))?.split(/\s+/)[1];
  if (!host) throw new Error("could not parse host triple from rustc -vV");
  return host;
}

const triple = await hostTriple();
const outDir = join(desktop, "src-tauri", "binaries");
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `divisio-daemon-${triple}`);

console.log(`compiling daemon → ${outFile}`);
const build = Bun.spawn(
  ["bun", "build", "--compile", "--minify", join(repo, "apps/server/src/index.ts"), "--outfile", outFile],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) {
  console.error("daemon compile failed");
  process.exit(1);
}

const size = (await Bun.file(outFile).stat()).size;
console.log(`daemon binary: ${(size / 1024 / 1024).toFixed(1)} MB`);
