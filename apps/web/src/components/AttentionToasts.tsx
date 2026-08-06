import type { AttentionItem } from "../hooks/useAttention.ts";
import { IconButton } from "./ui/Button.tsx";
import { ApprovalIcon, CloseIcon } from "./ui/icons.ts";

/**
 * Alerts for threads that need a person while you are looking elsewhere.
 *
 * Stacked bottom-right, above the composer but out of the typing path. The whole
 * card is the jump target — reaching for a small link when you have four agents
 * running is exactly the friction this is meant to remove.
 */
export function AttentionToasts({
  items,
  onOpen,
  onDismiss,
}: {
  items: AttentionItem[];
  onOpen(threadId: string): void;
  onDismiss(threadId: string): void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="attention-stack" role="region" aria-label="Threads needing attention">
      {items.slice(0, 3).map((item) => (
        <div key={item.threadId} className="attention-toast">
          <button className="attention-main" onClick={() => onOpen(item.threadId)}>
            <ApprovalIcon />
            <span className="attention-body">
              <span className="attention-reason">{item.reason}</span>
              <span className="attention-title">{item.title}</span>
            </span>
          </button>
          <IconButton
            label="Dismiss"
            icon={<CloseIcon />}
            size="sm"
            onClick={() => onDismiss(item.threadId)}
          />
        </div>
      ))}
      {items.length > 3 && (
        <p className="attention-more">and {items.length - 3} more waiting</p>
      )}
    </div>
  );
}
