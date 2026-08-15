import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUsageScanCache, scanVendorHomes } from "./scanHomes.ts";

describe("scanVendorHomes", () => {
  let dir: string;

  afterEach(() => {
    resetUsageScanCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("reads Claude jsonl, dedupes content blocks, and includes cache", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const projects = join(dir, "claude", "projects", "demo");
    mkdirSync(projects, { recursive: true });
    const ts = new Date().toISOString();
    const block = (contentType: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        sessionId: "ses_scan",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-4",
          content: [{ type: contentType }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 20,
            output_tokens: 5,
          },
        },
      });
    writeFileSync(join(projects, "session.jsonl"), `${block("text")}\n${block("tool_use")}\n`);

    const now = Date.now();
    const scan = await scanVendorHomes({
      sinceMs: now - 24 * 60 * 60 * 1000,
      untilMs: now + 24 * 60 * 60 * 1000,
      claudeDirs: [join(dir, "claude", "projects")],
      codexDirs: [join(dir, "missing-codex")],
    });

    expect(scan.claudeFiles).toBe(1);
    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]?.cacheReadTokens).toBe(1000);
    expect(scan.records[0]?.inputTokens).toBe(10);
  });
});
