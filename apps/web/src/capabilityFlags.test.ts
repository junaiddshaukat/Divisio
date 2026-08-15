import { describe, expect, test } from "bun:test";
import type { AdapterCapabilities } from "@divisio/contracts";
import { CAPABILITY_FLAGS, capabilityOn, vendorResumeNote } from "./capabilityFlags.ts";

describe("capability flags", () => {
  test("covers every AdapterCapabilities key and no extras", () => {
    const listed = CAPABILITY_FLAGS.map((f) => f.key).sort();
    const required: (keyof AdapterCapabilities)[] = [
      "sessionResume",
      "interruptTurn",
      "modelSwitch",
      "approvals",
      "handoffExport",
      "worktreeAware",
      "usageSignals",
    ];
    expect(listed).toEqual([...required].sort());
  });

  test("unknown or missing is unsupported", () => {
    expect(capabilityOn(undefined, "sessionResume")).toBe(false);
    expect(capabilityOn({}, "sessionResume")).toBe(false);
    expect(capabilityOn({ sessionResume: false }, "sessionResume")).toBe(false);
    expect(capabilityOn({ sessionResume: true }, "sessionResume")).toBe(true);
  });
});

describe("vendor resume note", () => {
  test("stays quiet on an empty thread", () => {
    expect(
      vendorResumeNote({ hasHistory: false, sessionResume: false, hasVendorSession: false }),
    ).toBeNull();
  });

  test("says so when the CLI cannot resume", () => {
    const note = vendorResumeNote({
      hasHistory: true,
      sessionResume: false,
      hasVendorSession: true,
    });
    expect(note).toContain("cannot continue");
  });

  test("says so when resume is supported but nothing was saved", () => {
    const note = vendorResumeNote({
      hasHistory: true,
      sessionResume: true,
      hasVendorSession: false,
    });
    expect(note).toContain("No vendor session");
  });

  test("says nothing when resume will actually happen", () => {
    expect(
      vendorResumeNote({ hasHistory: true, sessionResume: true, hasVendorSession: true }),
    ).toBeNull();
  });
});
