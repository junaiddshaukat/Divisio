import { describe, expect, test } from "bun:test";
import {
  initialCodexTranscriptState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  processedTokens,
} from "./transcripts.ts";

function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  requestId?: string;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "ses_test",
    requestId: overrides.requestId,
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-opus-4",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 80,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 4,
      },
    },
  });
}

describe("parseClaudeTranscriptLine", () => {
  test("maps disjoint counters and a message dedupe key", () => {
    const record = parseClaudeTranscriptLine(claudeLine({ messageId: "msg_1", contentType: "text" }));
    expect(record).toMatchObject({
      provider: "claude",
      model: "claude-opus-4",
      sessionId: "ses_test",
      inputTokens: 2,
      cacheReadTokens: 1000,
      cacheWriteTokens: 80,
      outputTokens: 4,
      dedupeKey: "msg_1:",
    });
    expect(processedTokens(record!)).toBe(1086);
  });

  test("content blocks of one message share a dedupe key", () => {
    const text = parseClaudeTranscriptLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const tool = parseClaudeTranscriptLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));
    expect(text?.dedupeKey).toBe(tool?.dedupeKey);
    expect(text?.inputTokens).toBe(tool?.inputTokens);
  });

  test("ignores non-assistant lines", () => {
    expect(parseClaudeTranscriptLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeTranscriptLine("not json")).toBeNull();
  });
});

describe("parseCodexTranscriptLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "ses_codex_1" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.5" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: 10,
          },
        },
      },
    });

  test("uses last_token_usage and subtracts cache from inclusive input", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(sessionMeta, state);
    parseCodexTranscriptLine(turnContext, state);
    const record = parseCodexTranscriptLine(tokenCount(19239, 11008, 299), state);
    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.5");
    expect(record?.sessionId).toBe("ses_codex_1");
    expect(record?.inputTokens).toBe(19239 - 11008);
    expect(record?.cacheReadTokens).toBe(11008);
    expect(record?.outputTokens).toBe(299);
  });

  test("skips a repeated token_count", () => {
    const state = initialCodexTranscriptState();
    parseCodexTranscriptLine(turnContext, state);
    expect(parseCodexTranscriptLine(tokenCount(100, 0, 10), state)).not.toBeNull();
    expect(parseCodexTranscriptLine(tokenCount(100, 0, 10), state)).toBeNull();
  });

  test("does not let a pre-model event poison the duplicate signature", () => {
    const state = initialCodexTranscriptState();
    expect(parseCodexTranscriptLine(tokenCount(100, 0, 10), state)).toBeNull();
    parseCodexTranscriptLine(turnContext, state);
    expect(parseCodexTranscriptLine(tokenCount(100, 0, 10), state)).not.toBeNull();
  });

  test("drops copied parent usage on a forked rollout", () => {
    const state = initialCodexTranscriptState();
    const forkMeta = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-01T06:00:00.000Z",
      payload: { type: "session_meta", id: "ses_fork", forked_from_id: "ses_parent" },
    });
    const context = JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-01T06:00:00.010Z",
      payload: { type: "turn_context", model: "gpt-5.5" },
    });
    const copied = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T06:00:00.040Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 0,
            output_tokens: 5,
          },
        },
      },
    });
    const genuine = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T06:00:08.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 20,
            cached_input_tokens: 0,
            output_tokens: 3,
          },
        },
      },
    });
    parseCodexTranscriptLine(forkMeta, state);
    parseCodexTranscriptLine(context, state);
    expect(parseCodexTranscriptLine(copied, state)).toBeNull();
    const later = parseCodexTranscriptLine(genuine, state);
    expect(later?.inputTokens).toBe(20);
    expect(later?.outputTokens).toBe(3);
  });
});
