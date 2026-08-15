import { describe, expect, test } from "bun:test";
import { formatHandoffTranscript, seedPrompt, summaryPrompt } from "./handoff.ts";

/**
 * The packet is written by the source agent, so what we control is its shape.
 * These assert the properties that make a handover usable by a different agent.
 */

describe("handoff prompts", () => {
  test("the summary prompt asks for structure and embeds the transcript", () => {
    const prompt = summaryPrompt("USER:\nShip search.\n\nASSISTANT:\nDone in src/search.ts.");
    for (const section of ["Goal", "Done", "Current state", "Next steps", "Watch out"]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("do not modify any files");
    expect(prompt).toContain("BEGIN DIVISIO TRANSCRIPT");
    expect(prompt).toContain("Ship search.");
    expect(prompt).toContain("Do not invent");
  });

  test("the seed tells the target it is taking over, not starting fresh", () => {
    const seed = seedPrompt("Goal: ship search.", "claude", { files: [], laneBranch: null });
    expect(seed).toContain("taking over work in progress");
    expect(seed).toContain("claude");
    expect(seed).toContain("Goal: ship search.");
    expect(seed).toContain("Read the relevant files before changing anything");
  });

  test("mechanical context is included when we have it", () => {
    const seed = seedPrompt("summary", "codex", {
      files: ["src/a.ts", "src/b.ts"],
      laneBranch: "divisio/add-search",
    });
    expect(seed).toContain("src/a.ts");
    expect(seed).toContain("divisio/add-search");
    expect(seed).toContain("recorded by the workspace");
  });

  test("a long file list is capped rather than flooding the prompt", () => {
    const files = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
    const seed = seedPrompt("summary", "claude", { files, laneBranch: null });
    expect(seed).toContain("src/file-0.ts");
    expect(seed).not.toContain("src/file-100.ts");
  });

  test("transcript formatter prefixes roles and skips empty text", () => {
    const text = formatHandoffTranscript([
      { role: "user", text: "  hi  " },
      { role: "assistant", text: "" },
      { role: "assistant", text: "hello" },
    ]);
    expect(text).toContain("USER:\nhi");
    expect(text).toContain("ASSISTANT:\nhello");
    expect(text.split("ASSISTANT").length).toBe(2);
  });
});
