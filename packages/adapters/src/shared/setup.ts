/**
 * How each provider CLI is installed and signed in.
 *
 * Onboarding needs to tell a user exactly what to run. These are declared data
 * rather than probed, deliberately:
 *
 * Probing auth has side effects. `cursor-agent status` does not report status —
 * it *starts a login flow*. A detect pass that runs on every connect must never
 * be able to launch a browser or a device-code prompt behind the user's back,
 * so we do not ask. `authenticated` stays null, which is the honest answer:
 * "the CLI offers no safe way to tell without starting work."
 *
 * The consequence is a first turn that may fail with an auth error. That is
 * recoverable and clearly worded; a detect that silently triggers logins is not.
 */

export interface ProviderSetup {
  /** Command that installs the CLI. */
  install: string;
  /** Command that signs the user in. */
  signIn: string;
  /** Where to read more, when the vendor documents it. */
  docs?: string;
}

export const PROVIDER_SETUP: Record<string, ProviderSetup> = {
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    signIn: "claude",
    docs: "https://docs.claude.com/en/docs/claude-code",
  },
  codex: {
    install: "npm install -g @openai/codex",
    signIn: "codex login",
  },
  cursor: {
    install: "curl https://cursor.com/install -fsS | bash",
    signIn: "cursor-agent login",
  },
  grok: {
    install: "npm install -g @vibe-kit/grok-cli",
    signIn: "grok",
  },
  qwen: {
    install: "npm install -g @qwen-code/qwen-code",
    signIn: "qwen",
  },
  opencode: {
    install: "curl -fsSL https://opencode.ai/install | bash",
    signIn: "opencode auth login",
  },
  gemini: {
    install: "npm install -g @google/gemini-cli",
    signIn: "gemini",
  },
  copilot: {
    install: "npm install -g @github/copilot",
    signIn: "copilot",
  },
  antigravity: {
    install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    signIn: "agy auth login",
  },
};

/** Setup commands for a provider, or nulls when we have none to offer. */
export function setupFor(kind: string): { install: string | null; signIn: string | null } {
  const entry = PROVIDER_SETUP[kind];
  return { install: entry?.install ?? null, signIn: entry?.signIn ?? null };
}
