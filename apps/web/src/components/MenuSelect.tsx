import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "./ui/icons.ts";

export interface MenuSelectOption {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  icon?: ReactNode;
}

interface Props {
  value: string;
  options: MenuSelectOption[];
  onChange(value: string): void;
  disabled?: boolean;
  placeholder?: string;
  /** Accessible name for the trigger. */
  "aria-label"?: string;
  className?: string;
}

interface PanelPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Custom listbox: branded trigger + floated menu (portaled so dialog overflow
 * cannot clip it).
 */
export function MenuSelect({
  value,
  options,
  onChange,
  disabled,
  placeholder = "Select…",
  "aria-label": ariaLabel,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  const place = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const preferred = 240;
    const below = window.innerHeight - rect.bottom - gap - 8;
    const above = rect.top - gap - 8;
    const openDown = below >= Math.min(preferred, 120) || below >= above;
    const maxHeight = Math.max(120, Math.min(preferred, openDown ? below : above));
    setPos({
      top: openDown ? rect.bottom + gap : Math.max(8, rect.top - gap - maxHeight),
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReposition = () => place();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  return (
    <div className={`menu-select ${className}`.trim()} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-select-trigger field"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="menu-select-value">
          {current?.icon}
          <span className="menu-select-text">
            <span className="menu-select-label">{current?.label ?? placeholder}</span>
            {current?.detail && <span className="menu-select-detail">{current.detail}</span>}
          </span>
        </span>
        <ChevronDownIcon className="menu-select-chevron" />
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={panelRef}
            className="menu-select-panel menu-select-panel-portal"
            role="listbox"
            id={listId}
            aria-label={ariaLabel}
            style={{
              top: pos.top,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
          >
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <li key={opt.value} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`menu-select-option${selected ? " selected" : ""}`}
                    disabled={opt.disabled}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    {opt.icon}
                    <span className="menu-select-text">
                      <span className="menu-select-label">{opt.label}</span>
                      {opt.detail && <span className="menu-select-detail">{opt.detail}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
