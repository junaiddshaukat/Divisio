/**
 * Packages the desktop app.
 *
 * On macOS the DMG step runs Finder AppleScript purely to position icons in the
 * installer window. That requires automation permission, which a fresh machine
 * or a CI runner does not grant, and the whole build fails on a cosmetic step.
 * Tauri skips it when CI is set, so we set it: a build that cannot complete
 * without a GUI permission prompt is not a build.
 */
const env = { ...process.env };
if (process.platform === "darwin" && !env["DIVISIO_DMG_COSMETICS"]) {
  env["CI"] = "true";
}

const proc = Bun.spawn(["bunx", "tauri", "build", ...Bun.argv.slice(2)], {
  cwd: new URL("..", import.meta.url).pathname,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
