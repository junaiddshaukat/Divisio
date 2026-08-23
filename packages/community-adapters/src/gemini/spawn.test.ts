import { describe, expect, test } from "bun:test";
import { geminiTurnArgs } from "../gemini.ts";
import { visibleCliText } from "../shared/pump.ts";

describe("geminiTurnArgs", () => {
  test("always skips the headless trust dialog, yolo only in full access", () => {
    const supervised = geminiTurnArgs({
      text: "hello",
      nativeId: null,
      permissionMode: "supervised",
    });
    expect(supervised).toContain("--skip-trust");
    expect(supervised).not.toContain("--yolo");

    const full = geminiTurnArgs({
      text: "hello",
      nativeId: "ses_1",
      permissionMode: "full_access",
      model: "gemini-2.5-pro",
    });
    expect(full).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--skip-trust",
      "--resume",
      "ses_1",
      "--yolo",
      "--model",
      "gemini-2.5-pro",
    ]);
  });
});

describe("visibleCliText", () => {
  test("strips ANSI color from Gemini trust errors", () => {
    const raw = "\x1b[31mGemini CLI is not running in a trusted directory.\x1b[0m";
    expect(visibleCliText(raw)).toBe("Gemini CLI is not running in a trusted directory.");
  });
});
