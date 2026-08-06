import { useCallback, useState, type RefObject } from "react";
import type { LaneView, PrResult } from "@divisio/contracts";
import type { Client } from "../client.ts";

/**
 * Parallel lanes: the worktrees, the board, and the delivery actions on them.
 *
 * Owns its own state so the board and the sidebar read the same list without
 * App having to thread it through as props.
 */
export function useLanes(clientRef: RefObject<Client | null>, onChanged: () => Promise<void>) {
  const [lanes, setLanes] = useState<LaneView[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setLanes((await client.send("lane.list", {})).lanes);
  }, [clientRef]);

  const create = useCallback(
    async (projectId: string, title: string) => {
      const client = clientRef.current;
      if (!client) return;
      setBusy(true);
      try {
        // Returns as soon as the worktree exists; setup keeps streaming, which
        // is why the lane shows as `preparing` rather than blocking here.
        await client.send("lane.create", { projectId, title });
        await onChanged();
      } finally {
        setBusy(false);
      }
    },
    [clientRef, onChanged],
  );

  const archive = useCallback(
    async (laneId: string, deleteBranch: boolean, force: boolean) => {
      await clientRef.current?.send("lane.archive", { laneId, deleteBranch, force });
      await onChanged();
    },
    [clientRef, onChanged],
  );

  const openPr = useCallback(
    async (laneId: string, title: string, commitMessage?: string): Promise<PrResult> => {
      const client = clientRef.current;
      if (!client) throw new Error("not connected");
      const result = await client.send("lane.openPr", {
        laneId,
        title,
        body: "Opened from Divisio.",
        ...(commitMessage ? { commitMessage } : {}),
      });
      await onChanged();
      return result;
    },
    [clientRef, onChanged],
  );

  const diff = useCallback(
    async (laneId: string) => {
      const client = clientRef.current;
      if (!client) return null;
      return client.send("lane.diff", { laneId });
    },
    [clientRef],
  );

  return { lanes, setLanes, busy, refresh, create, archive, openPr, diff };
}
