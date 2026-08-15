import type { ActivityDay } from "@divisio/contracts";

interface Props {
  days: ActivityDay[];
}

const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

function levelFor(turns: number): 0 | 1 | 2 | 3 | 4 {
  if (turns <= 0) return 0;
  if (turns === 1) return 1;
  if (turns <= 3) return 2;
  if (turns <= 6) return 3;
  return 4;
}

function parseLocal(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function monthLabel(date: string): string {
  return parseLocal(date).toLocaleString(undefined, { month: "short" });
}

/**
 * Year of local turns as a contribution-style grid.
 * Columns are weeks (Sun→Sat or Mon→Sun depending on locale Sunday=0).
 * We use Sunday-first to match common contribution graphs.
 */
export function ActivityHeatmap({ days }: Props) {
  if (days.length === 0) return null;

  // Pad the start so the first column begins on Sunday.
  const first = parseLocal(days[0]!.date);
  const pad = first.getDay(); // 0 = Sunday
  const cells: Array<ActivityDay | null> = [
    ...Array.from({ length: pad }, () => null),
    ...days,
  ];

  const weeks: Array<Array<ActivityDay | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  const monthMarks: { week: number; label: string }[] = [];
  let lastMonth = "";
  weeks.forEach((week, wi) => {
    const firstDay = week.find((d) => d !== null);
    if (!firstDay) return;
    const label = monthLabel(firstDay.date);
    if (label !== lastMonth) {
      monthMarks.push({ week: wi, label });
      lastMonth = label;
    }
  });

  return (
    <div className="activity-heatmap" role="img" aria-label="Activity over the past year">
      <div className="activity-heatmap-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((_, wi) => {
          const mark = monthMarks.find((m) => m.week === wi);
          return (
            <span key={wi} className="activity-heatmap-month">
              {mark?.label ?? ""}
            </span>
          );
        })}
      </div>
      <div className="activity-heatmap-body">
        <div className="activity-heatmap-weekdays" aria-hidden>
          {WEEKDAYS.map((label, i) => (
            <span key={i}>{label}</span>
          ))}
        </div>
        <div
          className="activity-heatmap-grid"
          style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}
        >
          {weeks.map((week, wi) => (
            <div key={wi} className="activity-heatmap-week">
              {Array.from({ length: 7 }, (_, di) => {
                const day = week[di] ?? null;
                if (!day) {
                  return <span key={di} className="activity-cell is-pad" />;
                }
                const level = levelFor(day.turns);
                const title =
                  day.turns === 0
                    ? `${day.date}: no turns`
                    : `${day.date}: ${day.turns} turn${day.turns === 1 ? "" : "s"}`;
                return (
                  <span
                    key={day.date}
                    className={`activity-cell level-${level}`}
                    title={title}
                    data-date={day.date}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="activity-heatmap-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`activity-cell level-${l}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
