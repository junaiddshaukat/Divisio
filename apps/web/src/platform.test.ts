import { describe, expect, test } from "bun:test";
import { isSafeExternalUrl } from "./platform.ts";

describe("isSafeExternalUrl", () => {
  test("allows http(s) and mailto", () => {
    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:hi@example.com")).toBe(true);
  });

  test("rejects schemes that would run in-process or open files", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("/relative")).toBe(false);
    expect(isSafeExternalUrl("https://example.com\n-o")).toBe(false);
  });
});
