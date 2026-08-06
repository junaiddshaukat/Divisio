import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { logger } from "@divisio/shared/log";

const log = logger("files");

/**
 * Reading and writing project files over the WebSocket API.
 *
 * Every path arriving here is untrusted input from a client. The daemon runs
 * with the user's full privileges, so a path that escapes the project root
 * turns a file browser into "read any file on this machine" — and, with write,
 * into arbitrary code execution via a shell profile or a git hook.
 *
 * Confinement is therefore enforced on the *resolved real* path, after symlinks,
 * not on the string the client sent.
 */

/** Files above this are not editable text; the UI offers download or nothing. */
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/** Never listed or opened, regardless of the request. */
const HIDDEN = new Set([".git", "node_modules", ".DS_Store", "target", "dist", ".next"]);

export class PathEscapeError extends Error {}
export class FileTooLargeError extends Error {}

export interface TreeEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
}

/**
 * Resolves a client-supplied relative path inside a root.
 *
 * Rejects absolute paths, `..` traversal, and symlinks that point outside —
 * checked against the real path, because a symlink inside the project can
 * otherwise be followed straight out of it.
 */
export function resolveInside(root: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new PathEscapeError("absolute paths are not accepted");
  }
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, relPath);

  const within = (candidate: string) => {
    const rel = relative(realRoot, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };

  if (!within(target)) throw new PathEscapeError("path escapes the project root");

  // Resolve symlinks where the target exists. A new file's parent must exist
  // and be inside, which covers "write through a symlinked directory".
  try {
    if (!within(realpathSync(target))) throw new PathEscapeError("path resolves outside the project root");
  } catch (err) {
    if (err instanceof PathEscapeError) throw err;
    const parent = dirname(target);
    try {
      if (!within(realpathSync(parent))) {
        throw new PathEscapeError("parent directory resolves outside the project root");
      }
    } catch (inner) {
      if (inner instanceof PathEscapeError) throw inner;
      // Parent does not exist yet; the string-level check above already passed.
    }
  }

  return target;
}

function hidden(name: string): boolean {
  return HIDDEN.has(name);
}

export async function listDirectory(root: string, relPath = ""): Promise<TreeEntry[]> {
  const dir = resolveInside(root, relPath);
  const entries = await readdir(dir, { withFileTypes: true });
  const out: TreeEntry[] = [];

  for (const entry of entries) {
    if (hidden(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const isDir = entry.isDirectory();
    let size: number | null = null;
    if (!isDir) {
      try {
        size = (await stat(join(dir, entry.name))).size;
      } catch {
        continue; // Vanished or unreadable; skip rather than fail the listing.
      }
    }
    out.push({ path: childRel, name: entry.name, kind: isDir ? "directory" : "file", size });
  }

  // Directories first, then alphabetical — the ordering a file tree needs.
  out.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
  );
  return out;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  /** Binary files are reported, never returned as mangled text. */
  binary: boolean;
}

export async function readTextFile(root: string, relPath: string): Promise<FileContent> {
  const target = resolveInside(root, relPath);
  const info = await stat(target);
  if (!info.isFile()) throw new PathEscapeError("not a file");

  if (info.size > MAX_EDITABLE_BYTES) {
    throw new FileTooLargeError(
      `file is ${(info.size / 1024 / 1024).toFixed(1)} MB; the editor opens files up to 2 MB`,
    );
  }

  const buf = await readFile(target);
  // A NUL byte in the first block is the usual heuristic, and good enough to
  // avoid handing an image to a text editor.
  const binary = buf.subarray(0, 8000).includes(0);
  return {
    path: relPath,
    content: binary ? "" : buf.toString("utf8"),
    size: info.size,
    binary,
  };
}

export async function writeTextFile(root: string, relPath: string, content: string): Promise<void> {
  const target = resolveInside(root, relPath);
  if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_BYTES) {
    throw new FileTooLargeError("refusing to write more than 2 MB from the editor");
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  log.info("file written from editor", { path: relPath });
}

export { MAX_EDITABLE_BYTES };
