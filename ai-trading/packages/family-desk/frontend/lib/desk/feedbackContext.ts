// What the Desk already knows when she opens the filing form (02s §Frontend): the screen and route she came from, the
// practice day or symbol in that route, the app version and the time. The form shows it and sends it, so it never asks
// for what the Desk can tell.

/** Set by `next.config.ts` at build time ("desk-2026.10.26"); a local run without it says `desk-dev`. */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_DESK_VERSION ?? "desk-dev";

/** The route the form was opened from when no screen is known: the Feedback area itself. */
export const FALLBACK_ROUTE = "/feedback";

// Longest matching prefix wins, like lib/lanes.ts.
const SCREENS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ["/", "Today"],
  ["/today", "Today"],
  ["/screener", "Screener"],
  ["/screener/filters", "Screener · Filter editor"],
  ["/watchlists", "Watchlists"],
  ["/alerts", "Alerts"],
  ["/alerts/new", "Alerts · New alert strategy"],
  ["/strategies", "Strategies"],
  ["/strategies/library", "Strategies · Library"],
  ["/strategies/new", "Strategies · New strategy"],
  ["/practice", "Practice"],
  ["/practice/replay", "Practice · Replay"],
  ["/practice/day", "Practice · Day list"],
  ["/practice/journal", "Practice · Journal"],
  ["/practice/week", "Practice · Week"],
  ["/technicals", "Technicals"],
  ["/futures", "Futures"],
  ["/futures/specs", "Futures · Specs"],
  ["/settings", "Settings"],
  ["/more", "More"],
  ["/feedback", "Feedback"],
  ["/feedback/new", "Feedback · New report"],
  ["/holdings", "Holdings"],
  ["/covered-calls", "Covered calls"],
  ["/stocks", "Stocks"],
];

/** Every screen name the "Which screen?" select offers, in route order, without repeats. */
export const SCREEN_OPTIONS: readonly string[] = [...new Set(SCREENS.map(([, label]) => label))];

const pathOf = (route: string): string => {
  const path = route.split(/[?#]/, 1)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path || "/";
};

export function screenFor(route: string): string {
  const path = pathOf(route);
  let best = "Today";
  let bestLength = -1;
  for (const [prefix, label] of SCREENS) {
    const matches = prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
    if (matches && prefix.length > bestLength) {
      best = label;
      bestLength = prefix.length;
    }
  }
  return best;
}

const MAX_ROUTE = 300;

/**
 * A route someone handed us in a link (`?from=`): a path on this site, with its query, without a fragment. Anything else,
 * and the form itself, is null, so a crafted link cannot put an address on another site into a report.
 */
export function cleanRoute(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const route = raw.trim().split("#", 1)[0] ?? "";
  if (!route.startsWith("/") || route.startsWith("//") || route.length > MAX_ROUTE) return null;
  // A control character or a backslash in a route is never one she was on.
  if (/[\\\u0000-\u001f]/.test(route)) return null;
  return pathOf(route) === "/feedback/new" ? null : route;
}

/** The previous page on this site, when the link carried no `from` (a bookmark, or a page opened from another tab). */
export function routeFromReferrer(referrer: string, origin: string): string | null {
  try {
    const url = new URL(referrer);
    return url.origin === origin ? cleanRoute(`${url.pathname}${url.search}`) : null;
  } catch {
    return null;
  }
}

export const captureRoute = (from: string | null, referrer: string, origin: string): string =>
  cleanRoute(from) ?? routeFromReferrer(referrer, origin) ?? FALLBACK_ROUTE;

const query = (route: string): URLSearchParams => new URLSearchParams(route.split("#", 1)[0]?.split("?", 2)[1] ?? "");

/** `?symbol=NVDA` on a chart or alert route. */
export function symbolOf(route: string): string | null {
  const symbol = query(route).get("symbol")?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9.\-^=]{1,12}$/.test(symbol) ? symbol : null;
}

/** The day list a Practice day route points at (`/practice/day?id=5`). */
export function dayListOf(route: string): number | null {
  if (pathOf(route) !== "/practice/day") return null;
  const id = Number(query(route).get("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export type Captured = {
  screen: string;
  route: string;
  symbol: string | null;
  dayListId: number | null;
  appVersion: string;
  /** ISO instant the form opened. */
  capturedAt: string;
};

export function capture({ route, now, appVersion = APP_VERSION }: { route: string; now: Date; appVersion?: string }): Captured {
  return { screen: screenFor(route), route, symbol: symbolOf(route), dayListId: dayListOf(route), appVersion, capturedAt: now.toISOString() };
}

/** The `context` object of the report: only what the route actually carried. */
export const contextOf = (captured: Captured): Record<string, unknown> => ({
  ...(captured.symbol ? { symbol: captured.symbol } : {}),
  ...(captured.dayListId ? { day_list_id: captured.dayListId } : {}),
});

/** The link behind "Report a problem": the form, with the screen she is on. */
export const reportUrl = (route: string): string => `/feedback/new?from=${encodeURIComponent(cleanRoute(route) ?? FALLBACK_ROUTE)}`;
