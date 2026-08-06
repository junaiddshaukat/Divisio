import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

/**
 * Custom listbox: branded trigger + floated menu.
 * Native &lt;select&gt; cannot show logos; this can.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu-select ${className}`.trim()} ref={rootRef}>
      <button
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
      {open && (
        <ul className="menu-select-panel" role="listbox" id={listId} aria-label={ariaLabel}>
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
        </ul>
      )}
    </div>
  );
}
