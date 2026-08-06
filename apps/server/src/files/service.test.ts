import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTooLargeError,
  PathEscapeError,
  listDirectory,
  readTextFile,
  resolveInside,
  writeTextFile,
} from "./service.ts";

/**
 * Every path here is untrusted client input, and the daemon runs with the
 * user's full privileges. An escape turns a file browser into "read anything",
 * and with write into code execution via a shell profile or a git hook.
 */

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "divisio-files-"));
  root = join(dir, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const x = 1;\n");
  await writeFile(join(root, "README.md"), "# hello\n");
  await writeFile(join(dir, "outside-secret.txt"), "SECRET\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("path confinement", () => {
  test("accepts paths inside the root", () => {
    expect(() => resolveInside(root, "src/app.ts")).not.toThrow();
    expect(() => resolveInside(root, "")).not.toThrow();
  });

  test("rejects parent traversal", () => {
    for (const p of ["../outside-secret.txt", "src/../../outside-secret.txt", "../../etc/passwd"]) {
      expect(() => resolveInside(root, p)).toThrow(PathEscapeError);
    }
  });

  test("rejects absolute paths", () => {
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(PathEscapeError);
  });

  test("rejects a symlink pointing outside the root", async () => {
    // The string looks harmless; only the resolved real path reveals the escape.
    await symlink(join(dir, "outside-secret.txt"), join(root, "innocent.txt"));
    expect(() => resolveInside(root, "innocent.txt")).toThrow(PathEscapeError);
  });

  test("rejects writing through a symlinked directory", async () => {
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await symlink(join(dir, "elsewhere"), join(root, "linkdir"));
    expect(() => resolveInside(root, "linkdir/new-file.txt")).toThrow(PathEscapeError);
  });
});

describe("listing", () => {
  test("lists directories first, then files", async () => {
    const entries = await listDirectory(root);
    expect(entries.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect(entries[0]!.kind).toBe("directory");
  });

  test("hides noise that would swamp a tree", async () => {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    const names = (await listDirectory(root)).map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
  });

  test("refuses to list outside the root", async () => {
    await expect(listDirectory(root, "..")).rejects.toThrow(PathEscapeError);
  });
});

describe("read and write", () => {
  test("reads a text file", async () => {
    const file = await readTextFile(root, "src/app.ts");
    expect(file.content).toBe("export const x = 1;\n");
    expect(file.binary).toBe(false);
  });

  test("reports binary rather than returning mangled text", async () => {
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const file = await readTextFile(root, "logo.png");
    expect(file.binary).toBe(true);
    expect(file.content).toBe("");
  });

  test("refuses files larger than the editor limit", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(3 * 1024 * 1024));
    await expect(readTextFile(root, "big.txt")).rejects.toThrow(FileTooLargeError);
  });

  test("writes a file and can read it back", async () => {
    await writeTextFile(root, "src/new.ts", "const y = 2;\n");
    expect((await readTextFile(root, "src/new.ts")).content).toBe("const y = 2;\n");
  });

  test("refuses to write outside the root", async () => {
    await expect(writeTextFile(root, "../escaped.txt", "nope")).rejects.toThrow(PathEscapeError);
  });
});
