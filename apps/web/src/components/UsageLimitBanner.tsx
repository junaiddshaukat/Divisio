import type { ProviderView } from "@divisio/contracts";
import { HandoffMenu } from "./HandoffMenu.tsx";

interface Props {
  message: string;
  current: string;
  providers: ProviderView[];
  turnBusy: boolean;
  handoffBusy: boolean;
  onHandoff(toProvider: string): void;
}

/**
 * Shown when the current CLI refused a turn for usage / rate-limit reasons.
 * We do not invent a quota percentage — only the vendor's own error copy.
 */
export function UsageLimitBanner({
  message,
  current,
  providers,
  turnBusy,
  handoffBusy,
  onHandoff,
}: Props) {
  return (
    <div className="usage-limit-banner" role="status">
      <div className="usage-limit-copy">
        <strong>This CLI hit a usage or rate limit</strong>
        <p>
          Divisio already has the transcript. Hand off to continue on another agent — the limited
          CLI does not need to write a note.
        </p>
        {message ? <p className="usage-limit-detail">{message}</p> : null}
      </div>
      <HandoffMenu
        current={current}
        providers={providers}
        turnBusy={turnBusy}
        handoffBusy={handoffBusy}
        logOnly
        onHandoff={onHandoff}
      />
    </div>
  );
}
