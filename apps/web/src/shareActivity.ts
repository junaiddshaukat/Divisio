import type { ActivityDay, ActivityTotals } from "@divisio/contracts";

export interface ShareCardData {
  name: string;
  handle: string;
  days: ActivityDay[];
  totals: ActivityTotals;
  peakDayTurns: number;
}

function levelFor(turns: number): number {
  if (turns <= 0) return 0;
  if (turns === 1) return 1;
  if (turns <= 3) return 2;
  if (turns <= 6) return 3;
  return 4;
}

const LEVEL_COLORS = ["#e8eaed", "#c5d4f5", "#7ea3e8", "#3b6fd4", "#1d4ed8"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Paint a light share card (avatar, heatmap, streak stats) to a canvas PNG.
 * No token counts — Divisio does not persist spend yet.
 */
export function renderShareCardPng(data: ShareCardData): Promise<Blob> {
  const W = 720;
  const H = 420;
  const canvas = document.createElement("canvas");
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);

  // Card background
  ctx.fillStyle = "#f4f4f5";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, 24, 24, W - 48, H - 48, 20);
  ctx.fill();
  ctx.strokeStyle = "#e4e4e7";
  ctx.lineWidth = 1;
  ctx.stroke();

  const padX = 48;
  let y = 52;

  // Avatar
  const av = 44;
  ctx.fillStyle = "#dbeafe";
  roundRect(ctx, padX, y, av, av, 22);
  ctx.fill();
  ctx.fillStyle = "#1d4ed8";
  ctx.font = "650 15px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials(data.name), padX + av / 2, y + av / 2 + 1);

  // Name + handle
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#18181b";
  ctx.font = "650 18px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(data.name, padX + av + 14, y + 18);
  ctx.fillStyle = "#71717a";
  ctx.font = "500 13px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(data.handle, padX + av + 14, y + 38);

  // Brand
  ctx.fillStyle = "#18181b";
  ctx.font = "650 14px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("Divisio", W - padX, y + 28);
  ctx.textAlign = "left";

  y = 120;

  // Heatmap (last ~20 weeks for card width)
  const first = data.days[0];
  const pad = first ? new Date(first.date + "T12:00:00").getDay() : 0;
  const cells: Array<ActivityDay | null> = [
    ...Array.from({ length: pad }, () => null),
    ...data.days,
  ];
  const weeks: Array<Array<ActivityDay | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const show = weeks.slice(-22);
  const cell = 10;
  const gap = 3;
  const gridW = show.length * (cell + gap) - gap;
  const startX = padX + Math.max(0, (W - padX * 2 - gridW) / 2);

  show.forEach((week, wi) => {
    for (let di = 0; di < 7; di++) {
      const day = week[di] ?? null;
      const level = day ? levelFor(day.turns) : 0;
      const x = startX + wi * (cell + gap);
      const cy = y + di * (cell + gap);
      ctx.fillStyle = day ? LEVEL_COLORS[level]! : "#f4f4f5";
      roundRect(ctx, x, cy, cell, cell, 2);
      ctx.fill();
    }
  });

  y += 7 * (cell + gap) + 28;

  // Stats row
  const stats: { value: string; label: string }[] = [
    { value: formatCompact(data.totals.turns), label: "lifetime turns" },
    { value: formatCompact(data.peakDayTurns), label: "peak day" },
    { value: `${data.totals.currentStreak}`, label: "current streak" },
    { value: `${data.totals.longestStreak}`, label: "longest streak" },
  ];
  const colW = (W - padX * 2) / stats.length;
  stats.forEach((s, i) => {
    const cx = padX + i * colW;
    if (i > 0) {
      ctx.strokeStyle = "#e4e4e7";
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(cx, y + 44);
      ctx.stroke();
    }
    ctx.fillStyle = "#18181b";
    ctx.font = "650 22px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(s.value, cx + colW / 2, y + 20);
    ctx.fillStyle = "#71717a";
    ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(s.label, cx + colW / 2, y + 40);
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("could not export image"));
    }, "image/png");
  });
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function peakDayTurns(days: ActivityDay[]): number {
  return days.reduce((max, d) => Math.max(max, d.turns), 0);
}

export function shareCaption(data: ShareCardData): string {
  return `My Divisio year — ${data.totals.turns} turns, ${data.totals.currentStreak}-day streak. Local agents, local activity.`;
}

export function handleFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
  return slug ? `@${slug}` : "@local";
}
