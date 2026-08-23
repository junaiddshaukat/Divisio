import { describe, expect, test } from "bun:test";
import { fileKind, statusLabel } from "./fileKind.ts";

describe("fileKind", () => {
  test("uses the extension, and gives known types their own colour", () => {
    expect(fileKind("src/App.tsx").label).toBe("tsx");
    expect(fileKind("src/App.tsx").color).not.toBe(fileKind("src/main.py").color);
  });

  test("reads the extension off the filename, not the directory path", () => {
    expect(fileKind("some.dir/Makefile").label).toBe("make");
    expect(fileKind("a.b.c/file.ts").label).toBe("ts");
  });

  test("a dotfile is named, not treated as one long extension", () => {
    expect(fileKind(".gitignore").label).toBe("git");
    expect(fileKind("app/.env").label).toBe("env");
  });

  test("an unknown extension still shows itself rather than a blank badge", () => {
    const kind = fileKind("data/report.xyz");
    expect(kind.label).toBe("xyz");
    expect(kind.color).toBeTruthy();
  });

  test("a file with no extension degrades without throwing", () => {
    expect(fileKind("LICENSE").label).toBeTruthy();
    expect(fileKind("").label).toBeTruthy();
  });

  test("long extensions are trimmed to keep the badge one size", () => {
    expect(fileKind("x.properties").label.length).toBeLessThanOrEqual(4);
  });
});

describe("statusLabel", () => {
  test("labels added, deleted and renamed", () => {
    expect(statusLabel("A")?.text).toBe("A");
    expect(statusLabel("D")?.text).toBe("D");
    expect(statusLabel("R")?.text).toBe("R");
  });

  test("modified is unlabelled — it is the common case and adds noise", () => {
    expect(statusLabel("M")).toBeNull();
  });
});
