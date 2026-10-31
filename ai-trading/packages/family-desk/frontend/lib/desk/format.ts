// Display formatting for the desktop screens (02m §a1, §d4). Every function takes API values (ISO UTC
// strings, numbers or null) and returns text; nothing here ever prints "null", "NaN" or "undefined".

import type { Tone as UiTone } from "../../components/ui/tone.ts";

const ET = "America/New_York";
const MINUS = "−";
export const EMPTY_VALUE = "—";

/** Legacy sign tone ("flat"); the new model is components/ui/tone.ts. Retires as each module migrates (design-component-system §7). */
export type Tone = "up" | "down" | "flat";
export type SignTone = Extract<UiTone, "up" | "down" | "neutral">;
export type MetricFormat = "price" | "pct" | "pct_signed" | "compact" | "ratio" | "number" | "time";

const cleanSpaces = (text: string) => text.replace(/[  ]/g, " ");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function partsOf(iso: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  // A plain date (a daily bar's as-of) has no time of day: reading it as midnight UTC would print the evening before.
  if (DATE_ONLY.test(iso) && (options.hour || options.minute)) return {};
  const date = new Date(DATE_ONLY.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return {};
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ET, ...options }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, cleanSpaces(value)]));
}

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** "3:45 PM" */
export function formatEtTime(iso: string | null): string {
  if (!iso) return EMPTY_VALUE;
  const p = partsOf(iso, { hour: "numeric", minute: "2-digit", hour12: true });
  return p.hour ? `${p.hour}:${p.minute} ${p.dayPeriod}` : EMPTY_VALUE;
}

/** "3:45 PM ET" */
export function formatEtTimeZone(iso: string | null): string {
  const time = formatEtTime(iso);
  return time === EMPTY_VALUE ? time : `${time} ET`;
}

/** "10:41:12 AM ET" (the reconnecting message) */
export function formatEtClock(iso: string | null): string {
  if (!iso) return EMPTY_VALUE;
  const p = partsOf(iso, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  return p.hour ? `${p.hour}:${p.minute}:${p.second} ${p.dayPeriod} ET` : EMPTY_VALUE;
}

/** "2026-10-23 15:45": the mocks' `time_et` text. */
export function formatEtStamp(iso: string | null): string {
  if (!iso) return EMPTY_VALUE;
  const p = partsOf(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return p.year ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : EMPTY_VALUE;
}

/** "Fri 2026-10-23" from a UTC instant or a plain `YYYY-MM-DD` date. */
export function formatEtDay(value: string | null): string {
  if (!value) return EMPTY_VALUE;
  const p = partsOf(value, { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  return p.year ? `${p.weekday} ${p.year}-${p.month}-${p.day}` : EMPTY_VALUE;
}

/** An as-of value: "3:45 PM ET" for a timestamp, "Fri 2026-10-23" for a plain date (daily and weekly data). */
export function formatAsOfText(value: string | null): string {
  if (!value) return EMPTY_VALUE;
  return DATE_ONLY.test(value) ? formatEtDay(value) : formatEtTimeZone(value);
}

/** "10:00" as "10:00 AM" (a list or window time the API names as HH:MM ET). */
export function formatClock(hhmm: string): string {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** "Mon 9:30 AM ET" */
export function formatEtWeekdayTime(iso: string | null): string {
  if (!iso) return EMPTY_VALUE;
  const p = partsOf(iso, { weekday: "short" });
  return p.weekday ? `${p.weekday} ${formatEtTimeZone(iso)}` : EMPTY_VALUE;
}

/** "As of last close · Fri 2026-10-23 · 4:00 PM ET" (02l §c1). */
export function formatLastCloseLine(iso: string | null, source?: string | null): string {
  if (!iso) return "No update yet";
  const line = `As of last close · ${formatEtDay(iso)} · ${formatEtTimeZone(iso)}`;
  return source ? `${line} · ${source}` : line;
}

export function formatPrice(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  const digits = Math.abs(value) < 1 ? 4 : 2;
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

/** "12.34%" */
export function formatPct(value: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  return `${value.toFixed(digits)}%`;
}

/** "+2.14%" / "−0.87%" / "0.00%": the sign is the cue, colour is secondary. */
export function formatSignedPct(value: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  const fixed = Math.abs(value).toFixed(digits);
  if (Number(fixed) === 0) return `${fixed}%`;
  return `${value > 0 ? "+" : MINUS}${fixed}%`;
}

/** "12.9M" */
export function formatCompact(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** "0.98×" (relative volume and similar ratios) */
export function formatRatio(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  return `${value.toFixed(2)}×`;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function formatMetric(format: MetricFormat, value: number | string | null | undefined): string {
  if (format === "time") return typeof value === "string" ? formatEtTime(value) : EMPTY_VALUE;
  if (typeof value !== "number") return EMPTY_VALUE;
  switch (format) {
    case "price": return formatPrice(value);
    case "pct": return formatPct(value);
    case "pct_signed": return formatSignedPct(value);
    case "compact": return formatCompact(value);
    case "ratio": return formatRatio(value);
    case "number": return formatNumber(value);
  }
}

/** The sign of a change as a ui/tone name: up, down, or neutral for zero, a missing value or NaN. */
export function signTone(value: number | null | undefined): SignTone {
  if (!isFiniteNumber(value) || value === 0) return "neutral";
  return value > 0 ? "up" : "down";
}

/** The legacy spelling ("flat" for neutral) for modules not yet moved onto components/ui/tone; each migration wave retires its callers. */
export function changeTone(value: number | null | undefined): Tone {
  const tone = signTone(value);
  return tone === "neutral" ? "flat" : tone;
}

/** "just now" / "2 min ago" / "3 hr ago" / "2 days ago" */
export function formatAgo(iso: string | null, now: Date): string {
  if (!iso) return EMPTY_VALUE;
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return EMPTY_VALUE;
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function initialOf(email: string | null | undefined): string {
  const first = (email ?? "").trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}
