// Time helpers for the Practice lane. Every instant on the wire is an ISO-8601 UTC string; the trader reads
// and types America/New_York wall-clock times, so these convert at the edge (DST-safe, no date library).

const ET = "America/New_York";

const hourMinute = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const wallParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const tapeClock = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export const ms = (iso: string): number => Date.parse(iso);

export const addMs = (iso: string, delta: number): string => new Date(ms(iso) + delta).toISOString();

/** Milliseconds ET is behind UTC at `instant` (positive: UTC-5 reads as 18_000_000). */
function etOffsetMs(instant: number): number {
  const parts = Object.fromEntries(wallParts.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((instant - wall) / 1000) * 1000;
}

/** "2026-10-23" + "10:15" (ET wall clock) to an ISO UTC instant. Null for a malformed input. */
export function etWallToUtcIso(day: string, hhmm: string): string | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!date || !time) return null;
  const wall = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]), Number(time[2]));
  // Offsets differ across a DST change, so settle on the offset that is true at the answer itself.
  let guess = wall + etOffsetMs(wall);
  guess = wall + etOffsetMs(guess);
  return new Date(guess).toISOString();
}

/** "10:07" ET wall clock (24 h) of an instant, for time inputs. */
export function etHhMm(iso: string): string {
  return hourMinute.format(new Date(ms(iso))).replace(/^24:/, "00:");
}

/** "10:07:11" ET (24 h): the tape's Time column. */
export function etTapeClock(iso: string): string {
  return tapeClock.format(new Date(ms(iso))).replace(/^24:/, "00:");
}

/** The ET calendar day of an instant, "2026-10-23". */
export function etDayOf(iso: string): string {
  const parts = Object.fromEntries(wallParts.formatToParts(new Date(ms(iso))).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
