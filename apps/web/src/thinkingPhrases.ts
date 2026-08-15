/**
 * Status verbs while a turn is running and no tokens have arrived yet.
 *
 * Gerunds, one or two words, command-center register — threads, turns,
 * worktrees, handoff — not a jokey list copied from another product.
 */

export const WORKING_VERBS = [
  "Thinking",
  "Exploring",
  "Reading",
  "Tracing",
  "Mapping",
  "Gathering",
  "Sifting",
  "Wiring",
  "Routing",
  "Checking",
  "Planning",
  "Assembling",
  "Reviewing",
  "Scanning",
  "Following",
  "Composing",
  "Stitching",
  "Settling",
  "Listening",
  "Walking",
  "Opening",
  "Picking",
  "Lining up",
  "Sorting",
  "Weighing",
  "Sharpening",
  "Drafting",
  "Parsing",
  "Linking",
  "Grounding",
  "Scoping",
  "Charting",
  "Aligning",
  "Reconciling",
  "Inspecting",
  "Untangling",
  "Narrowing",
  "Branching",
  "Orienting",
  "Surveying",
  "Distilling",
  "Sequencing",
  "Anchoring",
  "Tuning",
  "Framing",
  "Harvesting",
  "Cross-checking",
] as const;

/** Rotate so each wait starts on a different verb without reshuffling every tick. */
export function rotateWorkingVerbs(offset: number): string[] {
  const n = WORKING_VERBS.length;
  const start = ((offset % n) + n) % n;
  return [...WORKING_VERBS.slice(start), ...WORKING_VERBS.slice(0, start)];
}
