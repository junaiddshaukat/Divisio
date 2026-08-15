import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DeleteIcon, EditIcon } from "./ui/icons.ts";

export interface ThreadContextMenuState {
  threadId: string;
  title: string;
  x: number;
  y: number;
}

interface Props {
  menu: ThreadContextMenuState | null;
  onClose(): void;
  onRename(threadId: string): void;
  onDelete(threadId: string): void;
}

/** Fixed, portaled context menu for sidebar chat rows. */
export function ThreadContextMenu({ menu, onClose, onRename, onDelete }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setPos({
      top: Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)),
      left: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <ul
      ref={ref}
      className="thread-context-menu"
      role="menu"
      style={{ position: "fixed", top: pos.top, left: pos.left }}
    >
      <li role="none">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onRename(menu.threadId);
            onClose();
          }}
        >
          <EditIcon />
          Rename
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="is-danger"
          onClick={() => {
            onDelete(menu.threadId);
            onClose();
          }}
        >
          <DeleteIcon />
          Delete
        </button>
      </li>
    </ul>,
    document.body,
  );
}
