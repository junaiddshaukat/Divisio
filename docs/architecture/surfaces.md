# Surfaces

Clients are thin. All provider I/O and durable state live in the local daemon.

## Web (Phase 0 — primary)

- React + Vite app served by or proxied to `apps/server`
- Connects via WebSocket (same origin in dev; pairing token when remote)
- Owns: transcript UX, composer, project/thread navigation, approvals UI, capability matrix display

## Desktop (Phase 3 — early shell available)

- **Tauri** shell in `apps/desktop` starts/supervises the daemon and loads `apps/web` ([ADR 0006](../adr/0006-size-budget-tauri.md))
- Run: `bun run dev:desktop` (auto-connects; no token paste)
- Install artifact target **&lt; 150 MB**; Bun still required on PATH until a sidecar ships
- Must not fork a second orchestration stack — desktop is a host, not a second brain
- Visual shell matches [design system](../design/README.md) (three-pane command center)

## Remote pairing (Phase 3)

Principles:

- Daemon binds intentionally (loopback by default; opt-in LAN/Tailscale)
- First connection uses a **single-use pairing token** shown in the desktop UI or written to stdout, exchanged immediately for a revocable session token
- Remote access requires TLS or an encrypted overlay — plaintext `ws://` off loopback is prohibited
- Tokens are rotatable and individually revocable; restart can mint a new pair URL
- No Divisio cloud account required for remote access

Auth applies on loopback too — see [security.md](security.md#required-controls-all-of-them-on-every-listener). Localhost is never implicitly trusted.

Mobile is **out of scope** until web + desktop + pairing are solid.

## Feature parity rule

When adding user-visible behavior, check:

1. Web entry points (chat, settings, command palette, keybinding)
2. Desktop shell gaps (if desktop exists)
3. Every first-party adapter (or mark capability unsupported)
4. Local vs paired remote connection

## Related

- [Overview](overview.md)
- [Security](security.md)
- [Roadmap](../roadmap.md)
