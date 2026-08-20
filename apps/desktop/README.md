# Divisio desktop (Tauri)

Thin host around `apps/web` + `apps/server`. Not a second orchestration stack.

## Dev

From the monorepo root (requires Bun + Rust):

```bash
bun install
bun run dev:desktop
```

The shell:

1. Starts Vite for `apps/web`
2. Compiles the Bun daemon into `src-tauri/binaries/` and supervises that sidecar
3. Injects `~/.divisio/userdata/auth-token` into the UI (no paste gate)

If a compatible daemon is already listening on port 4577, the shell **attaches** and does not kill it on window close. ⌘R reloads the webview only.

## Build

```bash
bun run build:desktop
```

Installers / `.app` bundles appear under `src-tauri/target/release/bundle/`.

The packaged app **includes** the compiled daemon. Users do not need Bun on PATH. Measured macOS `.app` is 66 MB — see [benchmarks](../../docs/operations/benchmarks.md).
