export function signalsSinceEtStart(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  const midnightUtc = Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")));
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(midnightUtc)).find((entry) => entry.type === "timeZoneName")?.value;
  const match = offset?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Could not resolve New York market-day offset.");
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1);
  return new Date(midnightUtc - minutes * 60_000).toISOString();
}

export function signalCountsBySymbol(signals: readonly { symbol: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { symbol } of signals) counts[symbol] = (counts[symbol] ?? 0) + 1;
  return counts;
}
