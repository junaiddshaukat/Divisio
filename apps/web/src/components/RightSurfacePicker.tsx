import type { ReactNode } from "react";
import {
  BrowserIcon,
  DiffIcon,
  FileIcon,
} from "./ui/icons.ts";

export type RightSurface = "changes" | "files" | "browser";

interface Props {
  hasDiffHint?: boolean;
  onPick(surface: RightSurface): void;
}

/**
 * Empty right column: pick a working surface (terminal is the bottom dock).
 */
export function RightSurfacePicker({ hasDiffHint, onPick }: Props) {
  const tiles: {
    key: RightSurface;
    label: string;
    hint: string;
    icon: ReactNode;
    disabled?: boolean;
  }[] = [
    {
      key: "browser",
      label: "Browser",
      hint: "Preview a local URL",
      icon: <BrowserIcon />,
    },
    {
      key: "files",
      label: "Files",
      hint: "Browse and edit the project tree",
      icon: <FileIcon />,
    },
    {
      key: "changes",
      label: "Diff",
      hint: hasDiffHint ? "Review diffs and the working tree" : "Available when there are changes",
      icon: <DiffIcon />,
      disabled: !hasDiffHint,
    },
  ];

  return (
    <section className="surface-picker" aria-label="Open a surface">
      <div className="surface-tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            className="surface-tile"
            disabled={t.disabled}
            title={t.disabled ? t.hint : undefined}
            onClick={() => onPick(t.key)}
          >
            <span className="surface-tile-icon" aria-hidden>
              {t.icon}
            </span>
            <strong>{t.label}</strong>
            <span>{t.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
