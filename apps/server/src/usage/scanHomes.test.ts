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

    expect(scan.files.claude).toBe(1);
    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]?.cacheReadTokens).toBe(1000);
    expect(scan.records[0]?.inputTokens).toBe(10);
  });

  test("reads Grok turn deltas without inventing an I/O split", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const session = join(dir, "grok", "sessions", "demo");
    mkdirSync(session, { recursive: true });
    const ts = Date.now();
    const line = (total: number, kind: string) =>
      JSON.stringify({
        timestamp: ts,
        params: {
          sessionId: "grok_ses",
          update: { sessionUpdate: kind },
          _meta: { totalTokens: total, agentTimestampMs: ts, promptId: "p1" },
        },
      });
    writeFileSync(join(session, "updates.jsonl"), `${line(40, "agent_message_chunk")}\n${line(90, "turn_completed")}\n`);

    const scan = await scanVendorHomes({
      sinceMs: ts - 24 * 60 * 60 * 1000,
      untilMs: ts + 24 * 60 * 60 * 1000,
      grokDirs: [join(dir, "grok", "sessions")],
    });
    expect(scan.files.grok).toBe(1);
    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]?.totalTokens).toBe(90);
    expect(scan.records[0]?.inputTokens).toBe(0);
    expect(scan.records[0]?.outputTokens).toBe(0);
  });

  test("reads Qwen usage jsonl", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const usage = join(dir, "qwen", "usage");
    mkdirSync(usage, { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(
      join(usage, "token-usage-2026-08.jsonl"),
      `${JSON.stringify({
        id: "q1",
        timestamp: ts,
        sessionId: "ses_q",
        model: "Qwen3.8-Max",
        inputTokens: 10,
        outputTokens: 3,
        cachedTokens: 2,
        totalTokens: 15,
      })}\n`,
    );

    const now = Date.now();
    const scan = await scanVendorHomes({
      sinceMs: now - 24 * 60 * 60 * 1000,
      untilMs: now + 24 * 60 * 60 * 1000,
      qwenDirs: [usage],
    });
    expect(scan.files.qwen).toBe(1);
    expect(scan.records[0]).toMatchObject({ provider: "qwen", inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 });
  });

  test("reads Cursor composer bubbles from sqlite", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const dbPath = join(dir, "state.vscdb");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("create table cursorDiskKV (key text, value text)");
    db.query("insert into cursorDiskKV (key, value) values (?, ?)").run(
      "bubbleId:comp1:b1",
      JSON.stringify({
        bubbleId: "b1",
        createdAt: Date.now(),
        modelName: "gpt-5",
        tokenCount: { inputTokens: 25, outputTokens: 5 },
      }),
    );
    db.close();

    const now = Date.now();
    const scan = await scanVendorHomes({
      sinceMs: now - 24 * 60 * 60 * 1000,
      untilMs: now + 24 * 60 * 60 * 1000,
      cursorDbPaths: [dbPath],
    });
    expect(scan.files.cursor).toBe(1);
    expect(scan.records[0]).toMatchObject({ provider: "cursor", inputTokens: 25, outputTokens: 5 });
  });

  test("skips an oversized Cursor database instead of loading it", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const dbPath = join(dir, "state.vscdb");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("create table cursorDiskKV (key text, value text)");
    db.query("insert into cursorDiskKV (key, value) values (?, ?)").run(
      "bubbleId:comp1:b1",
      JSON.stringify({
        bubbleId: "b1",
        createdAt: Date.now(),
        modelName: "gpt-5",
        tokenCount: { inputTokens: 25, outputTokens: 5 },
      }),
    );
    db.close();

    const now = Date.now();
    const scan = await scanVendorHomes({
      sinceMs: now - 24 * 60 * 60 * 1000,
      untilMs: now + 24 * 60 * 60 * 1000,
      cursorDbPaths: [dbPath],
      maxSqliteBytes: 1,
    });
    expect(scan.files.cursor).toBe(0);
    expect(scan.records).toHaveLength(0);
  });

  test("reads OpenCode step-finish tokens from sqlite", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const dbPath = join(dir, "opencode.db");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("create table part (id text, message_id text, session_id text, time_created integer, data text)");
    db.exec("create table message (id text, data text)");
    db.query("insert into message (id, data) values (?, ?)").run("m1", JSON.stringify({ modelID: "gpt-5" }));
    db.query("insert into part (id, message_id, session_id, time_created, data) values (?, ?, ?, ?, ?)").run(
      "p1",
      "m1",
      "ses_o",
      Date.now(),
      JSON.stringify({ type: "step-finish", tokens: { input: 8, output: 2, cache: { read: 4, write: 1 } } }),
    );
    db.close();

    const now = Date.now();
    const scan = await scanVendorHomes({
      sinceMs: now - 24 * 60 * 60 * 1000,
      untilMs: now + 24 * 60 * 60 * 1000,
      opencodeDbPaths: [dbPath],
    });
    expect(scan.files.opencode).toBe(1);
    expect(scan.records[0]).toMatchObject({
      provider: "opencode",
      model: "gpt-5",
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
    });
  });

  test("coalesces concurrent scans of the same window", async () => {
    dir = mkdtempSync(join(tmpdir(), "divisio-usage-"));
    const projects = join(dir, "claude", "projects", "demo");
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      join(projects, "session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: "ses_coalesce",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-4",
          content: [{ type: "text" }],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      })}\n`,
    );
    const now = Date.now();
    const input = {
      sinceMs: now - 24 * 60 * 60 * 1000,
      untilMs: now + 24 * 60 * 60 * 1000,
      claudeDirs: [join(dir, "claude", "projects")],
    };
    const [a, b] = await Promise.all([scanVendorHomes(input), scanVendorHomes(input)]);
    expect(a).toBe(b);
    expect(a.records).toHaveLength(1);
    const again = await scanVendorHomes(input);
    expect(again).toBe(a);
  });
});
