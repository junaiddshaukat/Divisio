import { useEffect, useRef, useState } from "react";
import {
  canOpenExternally,
  copyPath,
  openExternal,
  type OpenExternalTarget,
} from "../platform.ts";
import { IconButton } from "./ui/Button.tsx";
import { CopyIcon, ExternalIcon, FinderIcon, OpenInIcon } from "./ui/icons.ts";

interface Props {
  workdir: string | null;
  onHint?(message: string): void;
}

/**
 * Open the thread working directory in Finder, Cursor, or VS Code.
 */
export function OpenInMenu({ workdir, onHint }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const desktop = canOpenExternally();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!desktop || !workdir) return null;

  const run = async (target: OpenExternalTarget | "copy") => {
    setOpen(false);
    if (target === "copy") {
      const ok = await copyPath(workdir);
      onHint?.(ok ? "Path copied." : "Couldn’t copy path.");
      return;
    }
    const res = await openExternal(workdir, target);
    if (res === "ok") return;
    if (res === "missing") {
      const name = target === "cursor" ? "Cursor (`cursor`)" : target === "code" ? "VS Code (`code`)" : "file manager";
      onHint?.(`${name} not found on PATH.`);
      return;
    }
    onHint?.("Couldn’t open the folder.");
  };

  return (
    <div className="open-in" ref={rootRef}>
      <IconButton
        label="Open"
        icon={<OpenInIcon />}
        size="sm"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="open-in-menu" role="menu" aria-label="Open project">
          <button type="button" role="menuitem" className="open-in-row" onClick={() => void run("finder")}>
            <FinderIcon />
            <span>Finder</span>
          </button>
          <button type="button" role="menuitem" className="open-in-row" onClick={() => void run("cursor")}>
            <ExternalIcon />
            <span>Cursor</span>
          </button>
          <button type="button" role="menuitem" className="open-in-row" onClick={() => void run("code")}>
            <ExternalIcon />
            <span>VS Code</span>
          </button>
          <button type="button" role="menuitem" className="open-in-row" onClick={() => void run("copy")}>
            <CopyIcon />
            <span>Copy path</span>
          </button>
        </div>
      )}
    </div>
  );
}
