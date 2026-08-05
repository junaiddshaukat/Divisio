/**
 * Every user-visible and on-disk identity string lives here.
 *
 * The working name may still change. When it does, this file is the only thing
 * that edits — not a repo-wide find and replace across config paths, URL
 * schemes, and protocol strings that have quietly diverged.
 *
 * Nothing outside this file hardcodes the product name.
 */

/** Display name, used in UI chrome and CLI output. */
export const PRODUCT_NAME = "Divisio";

/** Lowercase slug for filesystem, package scope, and config use. */
export const PRODUCT_SLUG = "divisio";

/**
 * Deep-link scheme. Must begin with a letter per RFC 3986:
 *   scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
 */
export const URL_SCHEME = PRODUCT_SLUG;

/** Home directory name under the user's home, e.g. ~/.divisio */
export const HOME_DIR_NAME = `.${PRODUCT_SLUG}`;

/** SQLite database filename inside the userdata directory. */
export const DB_FILENAME = "state.sqlite";

/**
 * WebSocket subprotocol, and therefore the wire-compatibility boundary.
 * A breaking protocol change mints a new value here — never a silent
 * redefinition. See docs/architecture/ws-protocol.md.
 */
export const WS_SUBPROTOCOL = `${PRODUCT_SLUG}.v1`;

/** Default loopback port for the daemon's HTTP + WebSocket listener. */
export const DEFAULT_PORT = 4577;

/** Environment variable prefix, e.g. DIVISIO_HOME. */
export const ENV_PREFIX = "DIVISIO";
