import { describe, expect, test } from "bun:test";
import { CommandError } from "@divisio/contracts";
import { validateModel, validateNativeId } from "./models.ts";

/**
 * The model slug is client-supplied and becomes an argv entry for a vendor CLI.
 * Adapters use argument arrays rather than a shell, so this is not a shell
 * injection path — but the daemon should not forward arbitrary strings to a
 * binary just because a client sent them.
 */

describe("model validation", () => {
  test("absent, empty, and 'default' all mean: let the CLI choose", () => {
    expect(validateModel(undefined)).toBeNull();
    expect(validateModel(null)).toBeNull();
    expect(validateModel("")).toBeNull();
    expect(validateModel("   ")).toBeNull();
    expect(validateModel("default")).toBeNull();
  });

  test("accepts the slug shapes real CLIs use", () => {
    for (const slug of [
      "claude-opus-4-6",
      "claude-opus-5",
      "claude-fable-5",
      "opus[1m]",
      "fable",
      "gpt-5.6-sol",
      "grok-4.5",
      "Gemini 3.1 Pro (High)",
      "openai/gpt-5.4",
      "qwen3-coder-plus",
      "gpt-5.2-codex",
      "gemini-2.5-pro",
      "anthropic/claude-sonnet-4",
      "qwen3-coder:480b",
      "grok-code-fast-1",
    ]) {
      expect(validateModel(slug)).toBe(slug);
    }
  });

  test("rejects a value that would arrive as another flag", () => {
    // The danger is argv position, not shell metacharacters: `--model` followed
    // by something the CLI reads as its own switch.
    expect(() => validateModel("--dangerously-skip-permissions")).toThrow(CommandError);
    expect(() => validateModel("-f")).toThrow(CommandError);
  });

  test("rejects shell metacharacters", () => {
    for (const bad of ["a;rm -rf /", "a|b", "a$(id)", "a`id`", "a\nb", "a&b"]) {
      expect(() => validateModel(bad)).toThrow(CommandError);
    }
  });

  test("allows spaces used by Antigravity display names", () => {
    expect(validateModel("Gemini 3.1 Pro (High)")).toBe("Gemini 3.1 Pro (High)");
  });

  test("rejects an absurdly long value", () => {
    expect(() => validateModel("a".repeat(101))).toThrow(CommandError);
  });

  test("trims surrounding whitespace rather than rejecting it", () => {
    expect(validateModel("  claude-opus-4-6  ")).toBe("claude-opus-4-6");
  });
});

describe("native session id validation", () => {
  test("accepts the id shapes real CLIs emit", () => {
    for (const id of [
      "ses_fixture_text_001",
      "mock-native-1",
      "0194f0a2-3c1d-7b8e-9f01-23456789abcd",
      "qwen/sess_1",
    ]) {
      expect(validateNativeId(id)).toBe(id);
    }
  });

  test("rejects values that would become another argv flag or split", () => {
    expect(validateNativeId(null)).toBeNull();
    expect(validateNativeId("")).toBeNull();
    expect(validateNativeId("  ")).toBeNull();
    expect(validateNativeId("-r")).toBeNull();
    expect(validateNativeId("--resume")).toBeNull();
    expect(validateNativeId("id with space")).toBeNull();
    expect(validateNativeId("a;rm")).toBeNull();
    expect(validateNativeId("a".repeat(201))).toBeNull();
  });
});

describe("validation ordering", () => {
  test("is documented as running before any state mutation", async () => {
    // Regression guard: validating after `activeTurnId` was set left the thread
    // permanently busy with no turn behind it. The check must precede
    // ensureSession in sendTurn.
    const source = await Bun.file(new URL("./orchestrator.ts", import.meta.url)).text();
    const body = source.slice(source.indexOf("private async sendTurn"));
    const validateAt = body.indexOf("validateModel(p.model)");
    const sessionAt = body.indexOf("ensureSession(p.threadId)");
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(sessionAt);
  });
});
