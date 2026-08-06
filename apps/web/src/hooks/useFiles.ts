import { useMemo, type RefObject } from "react";
import type { FileTreeEntry } from "@divisio/contracts";
import type { Client } from "../client.ts";

/**
 * File operations for the active thread.
 *
 * Extracted from App because every file surface needs exactly these three calls
 * and nothing else — keeping them beside three hundred lines of unrelated state
 * was the reason App had become hard to change.
 *
 * Paths resolve against the thread's working directory on the daemon, so a
 * lane-bound thread browses its own worktree.
 */
export interface FileApi {
  listDir(path: string): Promise<FileTreeEntry[]>;
  readFile(path: string): Promise<{ path: string; content: string; size: number; binary: boolean }>;
  writeFile(path: string, content: string): Promise<void>;
}

export function useFiles(
  clientRef: RefObject<Client | null>,
  threadIdRef: RefObject<string | null>,
): FileApi {
  return useMemo(
    () => ({
      async listDir(path) {
        const client = clientRef.current;
        // An absent thread is normal (nothing selected yet), not an error.
        if (!client || !threadIdRef.current) return [];
        return (await client.send("file.tree", { threadId: threadIdRef.current, path })).entries;
      },
      async readFile(path) {
        const client = clientRef.current;
        if (!client || !threadIdRef.current) throw new Error("not connected");
        return client.send("file.read", { threadId: threadIdRef.current, path });
      },
      async writeFile(path, content) {
        const client = clientRef.current;
        if (!client || !threadIdRef.current) throw new Error("not connected");
        await client.send("file.write", { threadId: threadIdRef.current, path, content });
      },
    }),
    [clientRef, threadIdRef],
  );
}
