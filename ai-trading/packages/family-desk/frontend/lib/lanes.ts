// The global-modes seam (ADR-0014, design-modes-cutover §3): four declarative tables decide what each mode shows. Routes
// (ROUTE_LANES), primary tabs (PRIMARY_NAV), shell sections (SECTION_LANES) and left-rail tabs (LEFT_RAIL_TABS). Moving a
// segment between modes is one edit to one row; `lanes.test.ts` fails when a page has no row or a tab leads out of its mode.
// The internal name stays `Lane`; people see "mode".
export type Lane = "technical" | "fundamental" | "backtest";
export const LANES: readonly Lane[] = ["technical", "fundamental", "backtest"];
export const LANE_LABEL: Record<Lane, string> = { technical: "Technical", fundamental: "Fundamental", backtest: "Backtest" };
/** One line per mode for the mode menu: what the mode holds. */
export const LANE_SUMMARY: Record<Lane, string> = {
  technical: "Screener, watchlists, alerts, strategies",
  fundamental: "Holdings, covered calls, research",
  backtest: "Day and swing practice on past days, journal",
};

/** Where "Back" goes from the shared futures specs page: the active mode's own futures screen (a link to the other mode's would land there and switch the mode). */
export const FUTURES_HOME: Record<Lane, { href: string; label: string }> = {
  technical: { href: "/futures", label: "Back to futures swing" },
  fundamental: { href: "/futures/read", label: "Back to futures" },
  backtest: { href: "/futures", label: "Back to futures swing" }, // unreachable: /futures/specs lists only Technical and Fundamental; the Record needs every mode
};

const T: Lane = "technical";
const F: Lane = "fundamental";
const B: Lane = "backtest";
const ALL = LANES;

// Route → the modes that show it. Longest matching prefix wins. A route renders in the current mode when the mode is listed,
// else in the FIRST listed mode (where a link from another mode lands).
const ROUTE_LANES: ReadonlyArray<readonly [string, readonly Lane[]]> = [
  ["/", ALL], // Backtest has no Today: LaneVariant sends it to /practice.
  ["/today", ALL],
  ["/screener", [T]],
  ["/watchlists", [T, F]],
  ["/alerts", [T]],
  ["/strategies", [T]],
  ["/technicals", [T]],
  ["/futures", [T]],
  ["/futures/specs", [T, F]],
  ["/futures/read", [F]],
  ["/holdings", [F]],
  ["/covered-calls", [F]],
  ["/stocks", [F]],
  ["/ask", [F, T]], // a fixture with no tab; never Backtest (no live advice on a practice surface)
  ["/practice", [B]],
  ["/backtests", [B]], // fixtures until backtesting is real
  ["/paper", [B]],
  ["/settings", ALL],
  ["/more", ALL],
  ["/feedback", ALL],
];

const normalize = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname) || "/";

function routeRow(pathname: string): readonly Lane[] | null {
  const path = normalize(pathname);
  let best: readonly Lane[] | null = null;
  let bestLength = -1;
  for (const [prefix, lanes] of ROUTE_LANES) {
    const matches = prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
    if (matches && prefix.length > bestLength) {
      best = lanes;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** The modes that show a route, landing mode first. An unknown path (a 404) lists every mode, so it never switches the mode. */
export const lanesForPath = (pathname: string): readonly Lane[] => routeRow(pathname) ?? ALL;

/** True when the route has its own row (the completeness test walks `app/` with it). */
export const isRegisteredPath = (pathname: string): boolean => routeRow(pathname) !== null;

/** The mode a page renders in: a listed `?mode=`, else the stored mode when the route lists it, else the route's landing mode. */
export function modeFor(pathname: string, param: string | null, stored: Lane): Lane {
  const modes = lanesForPath(pathname);
  const asked = modes.find((mode) => mode === param);
  if (asked) return asked;
  return modes.includes(stored) ? stored : modes[0]!;
}

/** Where the mode menu and the wordmark send each mode. `?mode=` picks the mode on the shared Today route. */
export const LANE_HOME: Record<Lane, string> = { technical: "/?mode=technical", fundamental: "/?mode=fundamental", backtest: "/practice" };

/** `match` is the path prefix that keeps the tab highlighted when it differs from `href`. */
export type NavItem = { label: string; href: string; match?: string };
/** Primary nav per mode. Settings and More live under the avatar menu (02l §b2). */
export const PRIMARY_NAV: Record<Lane, readonly NavItem[]> = {
  technical: [
    { label: "Today", href: "/" },
    { label: "Screener", href: "/screener" },
    { label: "Watchlists", href: "/watchlists" },
    { label: "Alerts", href: "/alerts" },
    { label: "Strategies", href: "/strategies/library", match: "/strategies" },
  ],
  fundamental: [
    { label: "Today", href: "/" },
    { label: "Holdings", href: "/holdings" },
    { label: "Covered calls", href: "/covered-calls" },
    { label: "Stocks", href: "/stocks" },
    { label: "Futures", href: "/futures/read", match: "/futures/read" },
  ],
  // Backtests joins when "Run backtest" stops being a fixture.
  backtest: [
    { label: "Practice", href: "/practice" },
    { label: "Journal", href: "/practice/journal" },
  ],
};

/** Shell sections per mode. A shell part asks `shows(lane, "marketPill")`; it never compares mode strings itself. */
const SECTION_LANES = {
  search: [T, F],
  marketPill: [T, F],
  freshness: [T, F],
  alertsBell: [T, F],
  mask: [F],
  statusQuotes: [T, F],
  statusAlerts: [T, F],
  fundamentalSettings: [F],
} as const satisfies Record<string, readonly Lane[]>;
export type ShellSection = keyof typeof SECTION_LANES;
export const shows = (lane: Lane, section: ShellSection): boolean => (SECTION_LANES[section] as readonly Lane[]).includes(lane);

export type LeftRailTab = "holdings" | "watchlists" | "filters";
/** Left-rail tabs per mode, first one open. Backtest keeps the one entry for its two fixture routes (/paper, /backtests): no Practice route reaches this rail (`hasPracticeLeftRail`). */
export const LEFT_RAIL_TABS: Record<Lane, readonly LeftRailTab[]> = {
  technical: ["watchlists", "filters"],
  fundamental: ["holdings", "watchlists"],
  backtest: ["watchlists"],
};

/** Where a symbol opens from a shared surface (search, rail, watchlists, bell). Backtest has no live symbol link. */
export const SYMBOL_HREF: Record<Lane, ((symbol: string) => string) | null> = {
  technical: (symbol) => `/technicals?symbol=${encodeURIComponent(symbol)}#chart`,
  fundamental: (symbol) => `/stocks?symbol=${encodeURIComponent(symbol)}#overview`,
  backtest: null,
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

/** The one tab to mark current: the longest matching one, so /practice/journal lights Journal and not Practice too. */
export function activeNavItem(items: readonly NavItem[], pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of items) {
    const match = item.match ?? item.href;
    if (isNavActive(item.href, pathname, item.match) && match.length > (best?.match ?? best?.href ?? "").length) best = item;
  }
  return best;
}

export const LANE_STORAGE_KEY = "desk.lane";
type LaneStorage = Pick<Storage, "getItem" | "setItem">;

export function readLanePreference(storage: LaneStorage | null): Lane {
  try {
    const value = storage?.getItem(LANE_STORAGE_KEY);
    return LANES.find((lane) => lane === value) ?? "technical";
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

/** Every Practice route owns the left slot, never the global watchlists: the replay, the day list and the journal fill it (D-013, D-039);
 * the hub, the thread page and the week review leave it empty, and the shell collapses an empty slot to 0 px. The watchlists were inert
 * there (a Backtest symbol has no link, `SYMBOL_HREF.backtest`) and showed live quotes beside a practice day. */
export const hasPracticeLeftRail = (pathname: string): boolean => isPracticePath(pathname);

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
