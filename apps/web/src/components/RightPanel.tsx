import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  clampRight,
  loadWidth,
  RIGHT_DEFAULT,
  saveWidth,
} from "../panelPrefs.ts";
import { IconButton } from "./ui/Button.tsx";
import { CloseIcon } from "./ui/icons.ts";

export type RightSurfaceId = "changes" | "files" | "browser" | "picker";

interface Props {
  surface: RightSurfaceId;
  dirtyHint?: boolean;
  onClose(): void;
  children: ReactNode;
}

const LABELS: Record<Exclude<RightSurfaceId, "picker">, string> = {
  changes: "Changes",
  files: "Files",
  browser: "Browser",
};

/**
 * Resizable right column. Surface switching lives in the topbar — this panel
 * only shows the active surface and a close control (no duplicate tab row).
 */
export function RightPanel({ surface, dirtyHint, onClose, children }: Props) {
  const [width, setWidth] = useState(() => clampRight(loadWidth("right", RIGHT_DEFAULT)));
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--right-w", `${width}px`);
  }, [width]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: width };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    const next = clampRight(drag.current.startW + (drag.current.startX - e.clientX));
    setWidth(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setWidth((w) => {
      saveWidth("right", w);
      return w;
    });
  }, []);

  const onDoubleClick = () => {
    setWidth(RIGHT_DEFAULT);
    saveWidth("right", RIGHT_DEFAULT);
  };

  const title =
    surface === "picker"
      ? "Open a surface"
      : `${LABELS[surface]}${surface === "changes" && dirtyHint ? " ·" : ""}`;

  return (
    <aside className="right-panel" style={{ width }} aria-label="Right surface">
      <div
        className="panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      <div className="right-panel-inner">
        <div className="right-tabs">
          <span className="right-panel-title">{title}</span>
          <IconButton
            label="Close panel"
            icon={<CloseIcon />}
            size="sm"
            className="right-tab-close"
            onClick={onClose}
          />
        </div>
        <div className="right-panel-body">{children}</div>
      </div>
    </aside>
  );
}
