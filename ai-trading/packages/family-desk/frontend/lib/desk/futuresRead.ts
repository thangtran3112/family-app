// FD6 Futures reading (02n §b3). The prices need futures quotes, which are deferred (02b §4b), so the screen shows the
// roots with their own reference dates and says plainly that prices are not connected.
export const READ_ROOTS = ["ES", "NQ", "CL", "GC"] as const;
export type ReadRoot = (typeof READ_ROOTS)[number];

export const ROOT_NAMES: Record<ReadRoot, string> = { ES: "E-mini S&P 500", NQ: "E-mini Nasdaq-100", CL: "Crude Oil (WTI)", GC: "Gold" };

/** Today's date in New York as `YYYY-MM-DD`: roll dates are calendar days in exchange time. */
export const todayEt = (now: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);

/** The first roll date on or after `today`, or null when the calendar has none left. */
export const nextRoll = (rollDates: readonly string[], today: string): string | null => [...rollDates].sort().find((date) => date >= today) ?? null;
