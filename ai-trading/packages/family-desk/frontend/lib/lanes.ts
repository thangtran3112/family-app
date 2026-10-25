// Route-to-lane map for the desktop shell (02m §c1). The Technical lane is the MVP; a route that
// belongs to the other lane shows the wrong-lane interstitial instead of its screen.
export type Lane = "technical" | "fundamental";
export const LANES: readonly Lane[] = ["technical", "fundamental"];
export const LANE_LABEL: Record<Lane, string> = { technical: "Technical", fundamental: "Fundamental" };

// Longest matching prefix wins, so "/strategies/library" can differ from "/strategies" if it ever must.
const ROUTE_LANES: ReadonlyArray<readonly [string, Lane]> = [
  ["/", "technical"],
  ["/today", "technical"],
  ["/screener", "technical"],
  ["/watchlists", "technical"],
  ["/alerts", "technical"],
  ["/strategies", "technical"],
  ["/practice", "technical"],
  ["/technicals", "technical"],
  ["/futures", "technical"],
  ["/settings", "technical"],
  ["/more", "technical"],
  ["/holdings", "fundamental"],
  ["/covered-calls", "fundamental"],
  ["/stocks", "fundamental"],
  // Not in the MVP: they sit behind the same interstitial until their own views exist.
  ["/paper", "fundamental"],
  ["/backtests", "fundamental"],
  ["/ask", "fundamental"],
];

const normalize = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname) || "/";

export function laneForPath(pathname: string): Lane {
  const path = normalize(pathname);
  let best: Lane = "technical";
  let bestLength = -1;
  for (const [prefix, lane] of ROUTE_LANES) {
    const matches = prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
    if (matches && prefix.length > bestLength) {
      best = lane;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** True when the route belongs to the other lane (so the shell shows the interstitial). */
export function isWrongLane(activeLane: Lane, pathname: string): boolean {
  return laneForPath(pathname) !== activeLane;
}

export const otherLane = (lane: Lane): Lane => (lane === "technical" ? "fundamental" : "technical");

/** `match` is the path prefix that keeps the tab highlighted when it differs from `href`. */
export type NavItem = { label: string; href: string; match?: string };
/** Primary nav per lane. Settings and More live under the avatar menu (02l §b2). */
export const PRIMARY_NAV: Record<Lane, readonly NavItem[]> = {
  technical: [
    { label: "Today", href: "/" },
    { label: "Screener", href: "/screener" },
    { label: "Watchlists", href: "/watchlists" },
    { label: "Alerts", href: "/alerts" },
    { label: "Strategies", href: "/strategies/library", match: "/strategies" },
    { label: "Practice", href: "/practice" },
  ],
  fundamental: [
    { label: "Holdings", href: "/holdings" },
    { label: "Covered calls", href: "/covered-calls" },
    { label: "Stocks", href: "/stocks" },
  ],
};

export const AVATAR_MENU: readonly NavItem[] = [
  { label: "Settings", href: "/settings" },
  { label: "More", href: "/more" },
];

export function isNavActive(href: string, pathname: string, match: string = href): boolean {
  const path = normalize(pathname);
  if (match === "/") return path === "/" || path === "/today";
  return path === match || path.startsWith(`${match}/`);
}

export const LANE_STORAGE_KEY = "desk.lane";
type LaneStorage = Pick<Storage, "getItem" | "setItem">;

export function readLanePreference(storage: LaneStorage | null): Lane {
  try {
    const value = storage?.getItem(LANE_STORAGE_KEY);
    return value === "fundamental" ? "fundamental" : "technical";
  } catch {
    return "technical";
  }
}

export function writeLanePreference(storage: LaneStorage | null, lane: Lane): void {
  try {
    storage?.setItem(LANE_STORAGE_KEY, lane);
  } catch {
    // Private mode or a full quota: the lane just resets on reload.
  }
}

/** True on the Practice hub, the replay workspace and the journal: they get the Practice band (02o §a1). */
export function isPracticePath(pathname: string): boolean {
  const path = normalize(pathname);
  return path === "/practice" || path.startsWith("/practice/");
}

/** The replay workspace puts its Session panel in the left rail instead of the watchlists. */
export const isReplayWorkspacePath = (pathname: string): boolean => normalize(pathname) === "/practice/replay";
