// Route-to-lane map for the desktop shell (02m §c1, 02n §b1). A route that belongs to the other lane shows the
// wrong-lane interstitial instead of its screen; a "shared" route renders the active lane's variant.
export type Lane = "technical" | "fundamental";
export type RouteLane = Lane | "shared";
export const LANES: readonly Lane[] = ["technical", "fundamental"];
export const LANE_LABEL: Record<Lane, string> = { technical: "Technical", fundamental: "Fundamental" };
/** One line per lane for the View chips' tooltips: what clicking the chip switches the app to (5R). */
export const LANE_SUMMARY: Record<Lane, string> = {
  technical: "Day and swing practice, screener, alerts",
  fundamental: "Holdings, covered calls, research",
};

/** Where "Back" goes from the shared futures specs page: the active lane's own futures screen (the other lane's would show the wrong-lane interstitial). */
export const FUTURES_HOME: Record<Lane, { href: string; label: string }> = {
  technical: { href: "/futures", label: "Back to futures swing" },
  fundamental: { href: "/futures/read", label: "Back to futures" },
};

// Longest matching prefix wins, so "/strategies/library" can differ from "/strategies" if it ever must.
const ROUTE_LANES: ReadonlyArray<readonly [string, RouteLane]> = [
  ["/", "shared"],
  ["/today", "shared"],
  ["/screener", "technical"],
  ["/watchlists", "shared"],
  ["/alerts", "technical"],
  ["/strategies", "technical"],
  ["/practice", "technical"],
  ["/technicals", "technical"],
  ["/futures", "technical"],
  ["/futures/specs", "shared"],
  ["/futures/read", "fundamental"],
  ["/settings", "shared"],
  ["/more", "shared"],
  ["/feedback", "technical"],
  ["/holdings", "fundamental"],
  ["/covered-calls", "fundamental"],
  ["/stocks", "fundamental"],
  // Not in the MVP: they sit behind the same interstitial until their own views exist.
  ["/paper", "fundamental"],
  ["/backtests", "fundamental"],
  ["/ask", "fundamental"],
];

const normalize = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname) || "/";

export function laneForPath(pathname: string): RouteLane {
  const path = normalize(pathname);
  let best: RouteLane = "technical";
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

/** True when the route belongs to the other lane (so the shell shows the interstitial); a shared route never does. */
export function isWrongLane(activeLane: Lane, pathname: string): boolean {
  const owner = laneForPath(pathname);
  return owner !== "shared" && owner !== activeLane;
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
    { label: "Today", href: "/" },
    { label: "Holdings", href: "/holdings" },
    { label: "Covered calls", href: "/covered-calls" },
    { label: "Stocks", href: "/stocks" },
    { label: "Futures", href: "/futures/read", match: "/futures/read" },
  ],
};

export const AVATAR_MENU: readonly NavItem[] = [
  { label: "Settings", href: "/settings" },
  { label: "More", href: "/more" },
  { label: "Feedback", href: "/feedback" },
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

/** The replay, the day list and the thread journal fill the left rail themselves (D-013, D-039) instead of showing the watchlists. */
export const hasPracticeLeftRail = (pathname: string): boolean => ["/practice/replay", "/practice/day", "/practice/journal"].includes(normalize(pathname));

/** The More group (Settings, More and the Feedback log, 02s) swaps the watchlists for the "Settings & More" section list (board `KSZ-0`). */
export const hasMoreLeftRail = (pathname: string): boolean => ["/settings", "/more", "/feedback", "/feedback/new"].includes(normalize(pathname));

export type MoreSection = { id: string; label: string; href: string; hash?: string };
// The Settings sections jump to their card on /settings; Feedback is its own route. "Strategies" is the Pause-all row, which the
// live Settings screen keeps inside its Alerts card.
export const MORE_SECTIONS: readonly MoreSection[] = [
  { id: "defaults", label: "Defaults", href: "/settings#settings-default-view", hash: "#settings-default-view" },
  { id: "channels", label: "Alert channels", href: "/settings#settings-alerts", hash: "#settings-alerts" },
  { id: "sources", label: "Data sources", href: "/settings#settings-market-data", hash: "#settings-market-data" },
  { id: "brokers", label: "Brokers", href: "/settings#settings-trading", hash: "#settings-trading" },
  { id: "strategies", label: "Strategies", href: "/settings#settings-strategies", hash: "#settings-strategies" },
  { id: "feedback", label: "Feedback", href: "/feedback" },
];

/** The selected section: Feedback on its routes; on Settings and More the one whose card the address points at (Defaults before any). */
export function moreSectionFor(pathname: string, hash: string): string {
  const path = normalize(pathname);
  if (path === "/feedback" || path.startsWith("/feedback/")) return "feedback";
  return MORE_SECTIONS.find((section) => section.hash === hash)?.id ?? "defaults";
}
