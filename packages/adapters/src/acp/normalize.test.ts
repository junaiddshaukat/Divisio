import { describe, expect, test } from "bun:test";
import {
  newAcpState,
  normalizeAcpPermissionRequest,
  normalizeAcpUpdate,
  selectAcpOptionId,
  type AcpPermissionOption,
} from "./normalize.ts";

describe("normalizeAcpUpdate", () => {
  test("streams assistant text and reports it for accumulation", () => {
    const state = newAcpState();
    const r = normalizeAcpUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      "trn",
      state,
    );
    expect(r.text).toBe("hello");
    expect(r.events).toEqual([{ type: "assistant.delta", turnId: "trn", text: "hello" }]);
  });

  test("thinking is not folded into assistant text", () => {
    const state = newAcpState();
    const r = normalizeAcpUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      "trn",
      state,
    );
    // Saving reasoning as the answer would corrupt the committed message.
    expect(r.text).toBe("");
    expect(r.events).toEqual([]);
  });

  test("a tool call is announced once across repeated updates", () => {
    const state = newAcpState();
    const first = normalizeAcpUpdate(
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read file", status: "pending" },
      "trn",
      state,
    );
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ type: "tool.started", toolCallId: "c1", name: "Read file" });

    const second = normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
      "trn",
      state,
    );
    expect(second.events).toEqual([]);

    const done = normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      "trn",
      state,
    );
    expect(done.events).toEqual([
      { type: "tool.finished", turnId: "trn", toolCallId: "c1", ok: true },
    ]);
  });

  test("a failed tool call reports ok:false", () => {
    const state = newAcpState();
    normalizeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "c1" }, "trn", state);
    const r = normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" },
      "trn",
      state,
    );
    expect(r.events).toEqual([{ type: "tool.finished", turnId: "trn", toolCallId: "c1", ok: false }]);
  });

  test("unknown update kinds are ignored rather than guessed at", () => {
    const state = newAcpState();
    expect(normalizeAcpUpdate({ sessionUpdate: "plan" }, "trn", state).events).toEqual([]);
    expect(normalizeAcpUpdate({}, "trn", state).events).toEqual([]);
  });
});

describe("normalizeAcpPermissionRequest", () => {
  const options = [
    { optionId: "a1", name: "Allow", kind: "allow_once" },
    { optionId: "a2", name: "Always allow", kind: "allow_always" },
    { optionId: "r1", name: "Reject", kind: "reject_once" },
  ];

  test("maps a shell tool call onto an approval event", () => {
    const r = normalizeAcpPermissionRequest(
      { options, toolCall: { kind: "execute", title: "run tests" } },
      "trn",
      "apr_1",
    );
    expect(r).not.toBeNull();
    expect(r!.event).toMatchObject({
      type: "approval.requested",
      turnId: "trn",
      approvalId: "apr_1",
      category: "shell.exec",
      summary: "run tests",
    });
    expect(r!.options).toHaveLength(3);
  });

  test("categorises edit and fetch tool calls", () => {
    const edit = normalizeAcpPermissionRequest({ options, toolCall: { kind: "edit" } }, "t", "a");
    expect(edit!.event).toMatchObject({ category: "fs.write" });
    const fetch = normalizeAcpPermissionRequest({ options, toolCall: { kind: "fetch" } }, "t", "a");
    expect(fetch!.event).toMatchObject({ category: "network" });
  });

  test("returns null when no usable option is offered", () => {
    // An approval bar that maps to nothing is worse than no bar at all.
    expect(normalizeAcpPermissionRequest({ options: [] }, "t", "a")).toBeNull();
    expect(normalizeAcpPermissionRequest({}, "t", "a")).toBeNull();
    expect(
      normalizeAcpPermissionRequest({ options: [{ optionId: "x", kind: "nonsense" }] }, "t", "a"),
    ).toBeNull();
  });
});

describe("selectAcpOptionId", () => {
  const opts: AcpPermissionOption[] = [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ];

  test("approve prefers the once-scoped option over a blanket grant", () => {
    // One click must never silently grant permission for the whole session.
    expect(selectAcpOptionId(opts, "approve")).toBe("once");
  });

  test("falls back to a blanket option only when nothing narrower exists", () => {
    const only: AcpPermissionOption[] = [{ optionId: "always", name: "A", kind: "allow_always" }];
    expect(selectAcpOptionId(only, "approve")).toBe("always");
  });

  test("deny picks a reject option, and reports when none exists", () => {
    expect(selectAcpOptionId(opts, "deny")).toBe("no");
    const noReject: AcpPermissionOption[] = [{ optionId: "once", name: "O", kind: "allow_once" }];
    expect(selectAcpOptionId(noReject, "deny")).toBeNull();
  });
});
