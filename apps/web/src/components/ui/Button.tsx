import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The button primitives.
 *
 * Every control previously carried its own class list and padding, which is why
 * nothing lined up. Variants live here so a new control cannot invent a fourth
 * shade of grey or a sixth height by accident.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Rendered before the label at icon size. */
  icon?: ReactNode;
  /** Replaces the label while an action is in flight. */
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control is unusable without an accessible name. */
  label: string;
  icon: ReactNode;
  size?: Size;
  variant?: "ghost" | "danger";
  active?: boolean;
}

export function IconButton({
  label,
  icon,
  size = "md",
  variant = "ghost",
  active,
  className = "",
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={`icon-btn icon-btn-${size} btn-${variant} ${className}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...rest}
    >
      {icon}
    </button>
  );
}

/** A small status or metadata chip. Never interactive — use a Button for that. */
export function Pill({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon}
      {children}
    </span>
  );
}
