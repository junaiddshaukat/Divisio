import type { AdapterCapabilities } from "@divisio/contracts";

/**
 * Labels for Settings → Providers. Keys must stay in lockstep with
 * `AdapterCapabilities` — the test fails if a flag is added and forgotten here.
 * Missing / unknown on a provider is treated as unsupported, never guessed.
 */
export const CAPABILITY_FLAGS: {
  key: keyof AdapterCapabilities;
  label: string;
  detail: string;
}[] = [
  {
    key: "sessionResume",
    label: "Resume CLI session",
    detail: "Continue the vendor conversation after Divisio or the CLI restarts",
  },
  {
    key: "interruptTurn",
    label: "Stop a turn",
    detail: "Cancel work in flight from Divisio",
  },
  {
    key: "modelSwitch",
    label: "Switch model",
    detail: "Accept a model slug on a turn",
  },
  {
    key: "approvals",
    label: "Mediate approvals",
    detail: "Divisio can Approve or Deny tool requests this CLI emits",
  },
  {
    key: "handoffExport",
    label: "Handoff packet",
    detail: "The adapter can produce extra vendor continuation state (Divisio can always seed from the transcript)",
  },
  {
    key: "worktreeAware",
    label: "Worktree-safe",
    detail: "Safe to run with cwd set to a lane worktree",
  },
  {
    key: "usageSignals",
    label: "Usage signals",
    detail: "Maps token counts the CLI actually emits — never invented",
  },
];

export function capabilityOn(
  caps: Record<string, boolean> | AdapterCapabilities | undefined,
  key: keyof AdapterCapabilities,
): boolean {
  return caps?.[key] === true;
}

/** Composer copy when the next prompt will not continue the vendor CLI session. */
export function vendorResumeNote(input: {
  hasHistory: boolean;
  sessionResume: boolean;
  hasVendorSession: boolean;
}): string | null {
  if (!input.hasHistory) return null;
  if (!input.sessionResume) {
    return "This CLI cannot continue its own session after a restart. The next prompt starts a new vendor conversation; this transcript stays here.";
  }
  if (!input.hasVendorSession) {
    return "No vendor session was saved for this thread. The next prompt starts a new CLI conversation.";
  }
  return null;
}
