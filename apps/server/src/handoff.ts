/**
 * Cross-provider handoff.
 *
 * Divisio has no model of its own and does not proxy provider keys, so the
 * continuation packet cannot be written by us. It is produced by the source
 * agent as a final turn — which means a handoff costs one turn on the source
 * provider, and the quality of the summary varies by provider. That cost is
 * stated plainly in the UI rather than hidden.
 *
 * What we contribute is the shape: a fixed prompt so summaries are comparable
 * across providers, the Divisio transcript (CLI session memory is unreliable),
 * plus the file list we already hold from checkpoints.
 */

export interface PacketContext {
  /** Files touched during the thread, from checkpoint diffs. */
  files: string[];
  laneBranch: string | null;
}

/**
 * Asks the source agent to write a handover note from the Divisio transcript.
 *
 * CLIs often lack Divisio chat history in their own session — never rely on
 * "remember our conversation." The transcript below is authoritative.
 */
export function summaryPrompt(transcript: string): string {
  const body = transcript.trim() || "(no messages yet — refuse to invent a goal)";
  return [
    "You are handing this task to a different coding agent that has no access to our conversation.",
    "Write a handover note for it. Do not address me, and do not modify any files.",
    "",
    "Use ONLY the Divisio conversation transcript below as source of truth.",
    "Do not invent goals, files, or progress that are not in the transcript.",
    "If the transcript is empty or too thin to hand off, say so in one short paragraph and stop.",
    "",
    "When there is enough context, cover exactly these sections:",
    "1. Goal — what we are trying to achieve, in two sentences at most.",
    "2. Done — what has already been changed, and where.",
    "3. Current state — what works, what is broken, what is half-finished.",
    "4. Next steps — the specific things that remain, in order.",
    "5. Watch out — constraints, decisions already made and why, and anything",
    "   that looks reasonable but would be wrong here.",
    "",
    "Be concrete. Name files, functions, and commands. Omit pleasantries.",
    "",
    "--- BEGIN DIVISIO TRANSCRIPT ---",
    body,
    "--- END DIVISIO TRANSCRIPT ---",
  ].join("\n");
}

/** Seeds the target thread. Marked as a handover so the agent does not treat it as a fresh request. */
export function seedPrompt(
  summary: string,
  fromProvider: string,
  context: PacketContext,
): string {
  const parts = [
    `You are taking over work in progress from another coding agent (${fromProvider}).`,
    "",
    "Here is its handover note:",
    "",
    summary.trim(),
    "",
  ];

  if (context.files.length > 0) {
    parts.push(
      `Files touched so far (recorded by the workspace, not by the previous agent): ${context.files
        .slice(0, 40)
        .join(", ")}`,
      "",
    );
  }
  if (context.laneBranch) {
    parts.push(`You are working on branch ${context.laneBranch}.`, "");
  }

  parts.push(
    "Read the relevant files before changing anything — the note may be incomplete or",
    "slightly out of date. Confirm the current state, then continue from Next steps.",
    "If the note says there was nothing to hand off, ask the user what to work on instead of guessing.",
  );

  return parts.join("\n");
}

/** Compact transcript for the summary prompt (role-prefixed, newest messages capped). */
export function formatHandoffTranscript(
  messages: Array<{ role: string; text: string }>,
  maxChars = 24_000,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of messages) {
    const text = m.text.trim();
    if (!text) continue;
    const block = `${m.role.toUpperCase()}:\n${text}`;
    if (used + block.length + 2 > maxChars) break;
    lines.push(block);
    used += block.length + 2;
  }
  return lines.join("\n\n");
}
