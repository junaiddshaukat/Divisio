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

/**
 * Outside a git repository there is no checkpoint to diff, so the provider's
 * own report of what it wrote is the only record the transcript can show.
 */
describe("files reported edited", () => {
  test("a completed edit reports the file it touched", () => {
    const state = newAcpState();
    normalizeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "e1", title: "edit" }, "t", state);
    const done = normalizeAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "e1",
        kind: "edit",
        status: "completed",
        locations: [{ path: "/work/page.html" }],
      },
      "t",
      state,
    );
    expect(done.events).toContainEqual({ type: "file.edited", turnId: "t", path: "/work/page.html" });
  });

  test("read-only tools never report a file as changed", () => {
    // Reporting a file because the agent read it would make the whole list
    // untrustworthy, which is worse than showing nothing.
    const state = newAcpState();
    for (const kind of ["read", "search", "list", "fetch", "other"]) {
      const r = normalizeAcpUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: `x-${kind}`,
          kind,
          status: "completed",
          locations: [{ path: "/work/secret.ts" }],
        },
        "t",
        state,
      );
      expect(r.events.filter((e) => e.type === "file.edited")).toEqual([]);
    }
  });

  test("an unfinished edit is not reported until it completes", () => {
    const state = newAcpState();
    const r = normalizeAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "e2",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: "/work/a.ts" }],
      },
      "t",
      state,
    );
    expect(r.events.filter((e) => e.type === "file.edited")).toEqual([]);
  });

  test("a failed edit is not reported as a change", () => {
    const state = newAcpState();
    const r = normalizeAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "e3",
        kind: "edit",
        status: "failed",
        locations: [{ path: "/work/a.ts" }],
      },
      "t",
      state,
    );
    expect(r.events.filter((e) => e.type === "file.edited")).toEqual([]);
  });

  test("the same file edited twice is reported once", () => {
    const state = newAcpState();
    const emit = (id: string) =>
      normalizeAcpUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          kind: "edit",
          status: "completed",
          locations: [{ path: "/work/a.ts" }],
        },
        "t",
        state,
      ).events.filter((e) => e.type === "file.edited");

    expect(emit("e4")).toHaveLength(1);
    expect(emit("e5")).toHaveLength(0);
  });

  test("directory and malformed locations are ignored", () => {
    const state = newAcpState();
    const r = normalizeAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "e6",
        kind: "edit",
        status: "completed",
        locations: [{ path: "." }, { path: "src/" }, { path: "" }, { nope: 1 }, "junk"],
      },
      "t",
      state,
    );
    expect(r.events.filter((e) => e.type === "file.edited")).toEqual([]);
  });
});

/**
 * A tool call is described across several updates: kind and locations arrive on
 * one, the completion status on a later one carrying neither. Deciding only
 * from the completion update reported nothing at all.
 */
describe("tool call fields split across updates", () => {
  test("an edit announced early is still reported when a later update completes it", () => {
    const state = newAcpState();
    normalizeAcpUpdate(
      { sessionUpdate: "tool_call", toolCallId: "s1", title: "search_replace" },
      "t",
      state,
    );
    // Kind and locations, no status.
    normalizeAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "s1",
        kind: "edit",
        locations: [{ path: "/work/page.html" }],
      },
      "t",
      state,
    );
    // Completion, carrying neither kind nor locations.
    const done = normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "s1", status: "completed" },
      "t",
      state,
    );
    expect(done.events).toContainEqual({
      type: "file.edited",
      turnId: "t",
      path: "/work/page.html",
    });
  });

  test("a read announced early is still not reported on completion", () => {
    const state = newAcpState();
    normalizeAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "r1",
        kind: "read",
        locations: [{ path: "/work/secret.ts" }],
      },
      "t",
      state,
    );
    const done = normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" },
      "t",
      state,
    );
    expect(done.events.filter((e) => e.type === "file.edited")).toEqual([]);
  });

  test("state for a finished call is released", () => {
    const state = newAcpState();
    normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "z1", kind: "edit", locations: [{ path: "/a" }] },
      "t",
      state,
    );
    expect(state.toolCalls.size).toBe(1);
    normalizeAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "z1", status: "completed" },
      "t",
      state,
    );
    expect(state.toolCalls.size).toBe(0);
  });
});
