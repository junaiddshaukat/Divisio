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
2. Spawns `bun apps/server/src/index.ts`
3. Injects `~/.divisio/userdata/auth-token` into the UI (no paste gate)

## Build

```bash
bun run build:desktop
```

Installers / `.app` bundles appear under `src-tauri/target/release/bundle/`.

**Note:** The packaged app still expects `bun` on PATH to run the daemon. Shipping a Bun sidecar inside the 150 MB budget is a follow-up.
