# Security

Security is a product feature. Divisio is the workspace layer on the user’s machine, not a cloud for their repos or chats.

## Trust model

| Boundary | Rule |
| --- | --- |
| Local data | Projects, threads, settings, history live in local SQLite / userdata |
| Provider traffic | Prompts, snippets, and tool results go **directly** to the chosen provider under the user’s existing login |
| Divisio cloud | None required; we do not proxy API keys or store customer code on our servers |
| Telemetry | Off by default; if added later, opt-in and never include code/prompts/chat bodies |

## Threat model for the local daemon

The daemon spawns shells and writes files on behalf of the user. **Any party that can send it an authenticated request has arbitrary code execution as that user.** Every rule below follows from that single fact.

### Loopback is not a trust boundary

Binding to `127.0.0.1` restricts which *hosts* can reach the port. It does not restrict which *programs on this host* can. Two attacks defeat naive loopback trust:

1. **Cross-origin WebSocket.** Browsers do not apply CORS preflight to WebSocket upgrades. Any page the user visits can open `ws://127.0.0.1:<port>` and, absent other checks, drive the daemon.
2. **DNS rebinding.** An attacker-controlled name resolves first to their server, then to `127.0.0.1`. The browser treats subsequent requests as same-origin with the attacker's page, defeating origin checks that rely on the browser alone.

Other local users and any unsandboxed local process can also reach the port.

### Required controls (all of them, on every listener)

| Control | Rule |
| --- | --- |
| **Origin allowlist** | Reject the WebSocket upgrade unless `Origin` exactly matches an allowlisted local UI origin. A missing `Origin` is rejected too — browsers always send it; non-browser clients use the token path and must not be granted origin-free access. |
| **Host allowlist** | Reject any request whose `Host` header is not `localhost`, `127.0.0.1`, or `[::1]` (plus the configured bind address when remote is enabled). This is the DNS-rebinding guard — it does not depend on the browser behaving. |
| **Token always** | Require a bearer token on **every** connection, including loopback. Localhost is never implicitly trusted. |
| **Token transport** | Send the token in the upgrade request (`Authorization` header or subprotocol), never in the URL query string — URLs leak into logs, history, and `Referer`. |
| **Token at rest** | Store in the userdata directory with `0600` permissions, directory `0700`. Never world-readable, never in the repo, never in a dotfile the shell prompt might echo. |
| **Constant-time compare** | Compare tokens with a timing-safe function, not `===`. |
| **Bind explicitly** | Default `127.0.0.1`. Binding `0.0.0.0` is an explicit, logged, opt-in action — never a fallback when a bind fails. |

A local UI that cannot read the token file is not authorized. There is no "same machine so it's fine" exception.

### Remote access

- **Never plaintext off loopback.** A bearer token over `ws://` on a shared network is sniffable, and the prize is shell access to the user's machine. Remote requires **TLS** (self-signed is fine, with certificate pinning captured at pairing time) **or** a Tailscale/WireGuard-style encrypted overlay. `ws://` bound to a LAN address is prohibited, not discouraged.
- Prefer the VPN/overlay path over exposing any port.
- Never expose the daemon to the public internet. No port-forwarding guidance ships in our docs.

### Pairing tokens

- First connection uses a **single-use** pairing token, shown in the desktop UI or written to stdout — exchanged immediately for a long-lived session token bound to that client.
- Pairing tokens expire on a short timer (minutes) whether or not they are used.
- Session tokens are individually revocable; a "revoke all clients" action must exist and must terminate live sockets, not just refuse new ones.
- Restart can mint a fresh pairing token. Treat pairing URLs as secrets: single-use, never logged in persistent analytics, never in shell history.

### Verifying these

These rules are testable and belong in the Phase 0 test suite, not in review comments:

- Upgrade with a foreign `Origin` → rejected
- Upgrade with a rebinding `Host` → rejected
- Upgrade with no token, on loopback → rejected
- Token in query string → rejected
- LAN bind without TLS → refuses to start

See [ws-protocol.md](ws-protocol.md) for where each check sits in the handshake.

## Permissions

Provider tool calls that mutate the system (write files, run shell, network) must honor Divisio permission modes — see [permissions](../specs/permissions.md). Supervised mode requires explicit user approval in the UI.

## Process isolation

- Provider CLIs run as child processes under the user’s OS user
- Prefer worktree `cwd` isolation for parallel lanes (Phase 2)
- Do not kill processes by name/pattern matching in agent tooling; track PIDs at spawn

## Secrets

- Do not commit `.env`, tokens, or userdata databases
- Do not log full pairing tokens in persistent analytics
- Adapter detect/auth should read vendor CLIs’ existing credentials — Divisio is not a password manager for provider accounts (multi-profile may come later)

## Supply chain

- We own the application code; no vendoring of third-party product trees
- Depend on well-known OSS libraries with pinned lockfiles once code exists
- Community adapters (Phase 4) run with clear trust boundaries documented in the SDK

## Related

- [WebSocket protocol](ws-protocol.md) — handshake, auth, and where each check runs
- [Surfaces](surfaces.md)
- [Permissions](../specs/permissions.md)
- ADR [0001-own-the-implementation](../adr/0001-own-the-implementation.md)
