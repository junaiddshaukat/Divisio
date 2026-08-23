import markDark from "../assets/divisio-mark-dark.png";
import markLight from "../assets/divisio-mark.png";

interface Props {
  size?: number;
  className?: string;
  /** Light-surface contexts (share card) always use the tiled mark. */
  tone?: "auto" | "light";
}

/** Folded prompt chevron. Decorative — nearby copy names the product. */
export function BrandMark({ size = 22, className = "", tone = "auto" }: Props) {
  const extra = className ? ` ${className}` : "";
  const toneClass = tone === "light" ? " is-on-light" : "";
  return (
    <span
      className={`brand-mark-wrap${toneClass}${extra}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={markLight}
        alt=""
        width={size}
        height={size}
        className="brand-mark brand-mark-light"
        draggable={false}
      />
      {tone === "auto" && (
        <img
          src={markDark}
          alt=""
          width={size}
          height={size}
          className="brand-mark brand-mark-dark"
          draggable={false}
        />
      )}
    </span>
  );
}
