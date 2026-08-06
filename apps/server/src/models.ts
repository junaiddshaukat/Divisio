import { CommandError } from "@divisio/contracts";

/**
 * Server-side validation of the model slug a client asks for.
 *
 * The value is client-supplied and ends up as an argv entry for a provider CLI.
 * Adapters spawn with argument arrays rather than a shell, so this is not a
 * shell-injection path — but the daemon should not forward an arbitrary string
 * to a vendor binary just because a client sent it. A compromised or simply
 * buggy client is enough reason to check.
 *
 * The rules are deliberately shape-based rather than an allow-list of names.
 * Model slugs change constantly, and a daemon that rejects a model the CLI
 * gained yesterday is worse than one that passes a harmless unknown string.
 */

/** Slugs are alphanumeric with separators — no spaces, no argv metacharacters. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

const MAX_LENGTH = 100;

export function validateModel(model: string | undefined | null): string | null {
  if (model === undefined || model === null) return null;

  const value = model.trim();
  if (value === "" || value === "default") return null;

  if (value.length > MAX_LENGTH) {
    throw new CommandError("invalid_payload", `model name is too long (max ${MAX_LENGTH} characters)`);
  }

  // A leading dash would arrive at the CLI as another flag rather than as the
  // value of --model. The regex already excludes it; this is the reason why.
  if (value.startsWith("-")) {
    throw new CommandError("invalid_payload", "model name may not start with '-'");
  }

  if (!SLUG.test(value)) {
    throw new CommandError(
      "invalid_payload",
      "model name may only contain letters, digits, and . _ : @ / -",
    );
  }

  return value;
}
