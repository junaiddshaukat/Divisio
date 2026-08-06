import { describe, expect, test } from "bun:test";
import type { ThreadView } from "@divisio/contracts";
import { needsAttention, rollUp, statusOf } from "./status.ts";

/**
 * Status presentation is shared by the sidebar, board, palette, and alerts.
 * These lock the properties those surfaces rely on.
 */

const thread = (status: ThreadView["status"]): ThreadView =>
  ({ id: status, status }) as ThreadView;

describe("status presentation", () => {
  test("every status has a label and a tone", () => {
    for (const s of [
      "connecting", "ready", "running", "awaiting_approval", "stopping", "error", "closed",
    ] as const) {
      const p = statusOf(s);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.tone).toBeTruthy();
    }
  });

  test("only states genuinely in motion pulse", () => {
    expect(statusOf("running").pulse).toBe(true);
    expect(statusOf("connecting").pulse).toBe(true);
    // A blocked thread is not moving; pulsing it would say the opposite.
    expect(statusOf("awaiting_approval").pulse).toBe(false);
    expect(statusOf("ready").pulse).toBe(false);
    expect(statusOf("error").pulse).toBe(false);
  });

  test("blocked and broken outrank busy", () => {
    expect(statusOf("awaiting_approval").priority).toBeGreaterThan(statusOf("running").priority);
    expect(statusOf("error").priority).toBeGreaterThan(statusOf("running").priority);
    expect(statusOf("running").priority).toBeGreaterThan(statusOf("ready").priority);
  });
});

describe("group rollup", () => {
  test("a collapsed group surfaces its most urgent thread", () => {
    const group = [thread("ready"), thread("running"), thread("awaiting_approval")];
    // Otherwise collapsing a project becomes a way to lose work.
    expect(rollUp(group)?.label).toBe("Needs approval");
  });

  test("an all-quiet group rolls up to idle", () => {
    expect(rollUp([thread("ready"), thread("ready")])?.label).toBe("Idle");
  });

  test("an empty group has nothing to show", () => {
    expect(rollUp([])).toBeNull();
  });
});

describe("attention", () => {
  test("only blocked or broken threads interrupt the user", () => {
    expect(needsAttention("awaiting_approval")).toBe(true);
    expect(needsAttention("error")).toBe(true);
    // A working agent is not yet the user's problem.
    expect(needsAttention("running")).toBe(false);
    expect(needsAttention("ready")).toBe(false);
  });
});
