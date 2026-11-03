import type { Tone } from "../../components/ui/tone.ts";
import type { Stamp } from "../api/schemas.ts";
import type { ShellBand } from "./viewport.ts";
import { formatAgo, formatAsOfText, formatEtClock, formatEtDateClock, formatEtDay, formatEtTime, formatEtTimeZone, formatEtWeekdayTime, formatLastCloseLine } from "./format.ts";

// The single copy table for freshness, session and empty/error wording (02l §c3, 02m §c3). Components
// never write these strings; they call the functions below. `{x}` marks a value filled at render time.
export const COPY = {
  live: "Live",
  delayed: "Delayed 15 min",
  updating: "Updating quotes…",
  reconnecting: "Reconnecting… · last update {time}",
  paused: "Quotes paused · last update {ago}",
  // The mark beside a price that is not current (V-Today-01): the age, in the same words the badge uses.
  staleMark: "Stale · {ago}",
  backup: "Using backup quotes · may differ slightly from IBKR",
  closed: "Market closed · showing last close",
  pre_market: "Pre-market · {time}",
  after_hours: "After hours",
  unavailable: "Quotes unavailable right now · trying again",
  alertsPaused: "Alerts paused until quotes return",
  alertsPausedByUser: "Alerts paused · all strategies are paused",
  alertsNotStarted: "Alerts start when live quotes are connected",
  alertsRunning: "Alerts on",
  statusUnavailable: "Status unavailable right now",
  /** The status bar in Backtest mode, where no route brings its own line (ADR-0014). */
  backtestStatus: "Practice · past market data",
  emptyScan: "No matches right now · next scan {time}",
  emptyScanNoTime: "No matches right now",
  loadError: "Couldn't load this {subject} · Try again",
  ordersOff: "Trading is off in the Desk · place orders in IBKR",
  advice: "Signals, not advice · you place every trade yourself in IBKR",
  marketClosedOpens: "Market closed · opens {time}",
  marketOpen: "Market open",
  marketPre: "Pre-market",
  marketAfter: "After hours",
  scanDelayed: "Scan delayed 15 min",
  scanning: "Scanning US stocks…",
  notEnoughHistory: "Not enough history for {timeframe} yet",
  noSignalsToday: "No signals yet today · no strategy is live yet",
  libraryUnavailable: "Strategy library unavailable · Try again",
  noAlertStrategies: "No alert strategies yet",
  futuresNotConnected: "Futures deferred · not connected yet",
  futuresReadOnly: "Futures · read only",
  firstScan: "Waiting for the first scan",
  newFilter: "New filter",
  noFilters: "No screener filters yet",
  quotesNotYet: "Quotes: Not updated yet",
  scansNotYet: "Scans: Not run yet",
  stripFirstUpdate: "First market update {time}",
  stripNoData: "No market data yet",
  stripLastClose: "Last close · {time}",
  // The Fundamental lane (02n §b4). "Not started" and "unavailable" are honest states, never a stand-in value.
  holdingsFresh: "Holdings as of {day} close · IBKR Flex",
  holdingsImporting: "Importing holdings…",
  holdingsImportFailed: "Couldn't import holdings · showing {day} · Try again",
  holdingsImportFailedNoData: "Couldn't import holdings · Try again",
  holdingsNotConnected: "Holdings aren't connected yet · set up the IBKR import in Settings",
  holdingsNone: "No holdings imported for you",
  optionQuotesNotConnected: "Option quotes connect after the Alpaca setup",
  ivRankShortHistory: "IV rank needs more history · opportunity alerts start later",
  exDividendUnknown: "Ex-dividend date unknown · check before selling a call",
  deskAiNotStarted: "Desk AI starts after its first daily run (5:05 PM ET)",
  deskAiStale: "Desk AI view from {day} · today's update didn't finish",
  valuesHidden: "Values hidden · Show values",
  futuresReadingOnly: "Reading only · switch to the Technical view to trade futures or swing",
  tax: "Not tax advice",
  // Surfaces whose source is not built yet (02n §e): shown as plain states, not errors.
  futuresDeferred: "Futures readings start once futures prices are connected",
  alertTemplatesNotStarted: "Fundamental alerts start once their data sources are connected",
  maskShow: "Show values",
  maskHide: "Hide values",
  // A symbol with no quote and no bars at all (V-Technicals-03): nothing will arrive, so no "trying again".
  noMarketData: "No market data for {symbol}",
  noMarketDataHint: "Check the symbol, or pick one from a watchlist",
  noMarketDataBadge: "No market data",
} as const;

// Words that must never reach the screen (02l §c3). `containsBannedTerm` is also used by the e2e specs.
export const BANNED_TERMS: readonly RegExp[] = [
  /\basync\b/i,
  /core async update/i,
  /\bfetch/i,
  /\bstream/i,
  /\bsocket/i,
  /\bpoll/i,
  /\btimeout/i,
  /\bnull\b/i,
  /\bnan\b/i,
  /stale cache/i,
  /\bhydrat/i,
  /\b(?:http|status|error|code)\s*:?\s*[1-5]\d{2}\b/i, // "Error 503", "HTTP 404"; prices and counts such as 210.99 or "9 of 131" do not match
  /\b[1-5]\d{2}\s+(?:error|not found|bad gateway|unauthorized|forbidden|internal server)/i,
  /\bundefined\b/i,
  /stack trace/i,
];

export function containsBannedTerm(text: string): boolean {
  return BANNED_TERMS.some((pattern) => pattern.test(text));
}

export type FreshnessState =
  | "live" | "delayed" | "updating" | "reconnecting" | "paused" | "backup"
  | "closed" | "pre_market" | "after_hours" | "unavailable";
/** Client-side connection state: a request in flight, or the quote connection down (02m §a1). */
export type Connection = "ok" | "updating" | "reconnecting";
export type MarketSession = "pre" | "regular" | "after" | "closed";

export type FreshnessInput = {
  stamp: Pick<Stamp, "freshness" | "quality" | "as_of" | "source"> | null;
  session?: MarketSession;
  connection?: Connection;
  /** The stamp covers the whole data feed (top bar, status bar, Today), not one symbol or one list. */
  feed?: boolean;
  /** The Desk feed's own stamp (the top bar's). A paused feed sets the age on every page badge, so the screen states one age. */
  feedStamp?: Pick<Stamp, "freshness" | "quality" | "as_of" | "source"> | null;
  now?: Date;
};

export type FreshnessView = {
  state: FreshnessState;
  label: string;
  tone: Tone;
  /** A filled dot beside the label (only "Live"). */
  dot: boolean;
  /** The last price stays visible but dimmed. */
  dim: boolean;
  /** The price on screen is old but still shown (quotes paused or dropped): it needs a mark, not only a dim. */
  stale: boolean;
  /** "Stale · 45 min ago" for a stale price, else null. */
  mark: string | null;
};

const TONE: Record<FreshnessState, Tone> = {
  live: "up",
  delayed: "neutral",
  updating: "neutral",
  reconnecting: "warn",
  paused: "warn",
  backup: "warn",
  closed: "neutral",
  pre_market: "neutral",
  after_hours: "neutral",
  unavailable: "down",
};

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
export const fillCopy = fill;

/** The page's own stamp, except while the feed is paused: then the feed's age is the only age (V-Today-01, V-SCR-01). */
function followFeed({ stamp, feedStamp }: Pick<FreshnessInput, "stamp" | "feedStamp">): FreshnessInput["stamp"] {
  if (!stamp || feedStamp?.freshness !== "paused") return stamp;
  if (stamp.freshness === "unavailable" || stamp.quality === "unavailable") return stamp; // a symbol the Desk cannot read stays unreadable
  return { ...stamp, freshness: "paused", as_of: feedStamp.as_of };
}

export function freshnessState(input: FreshnessInput): FreshnessState {
  const { session, connection = "ok", feed = false } = input;
  const stamp = followFeed(input);
  if (connection === "reconnecting") return "reconnecting";
  if (!stamp) return "updating";
  // A whole feed with nothing stored while the market is closed has nothing to retry: red "trying again" is for an
  // open session whose quotes stopped, or for one symbol the Desk cannot read.
  if (stamp.freshness === "unavailable" || stamp.quality === "unavailable") return feed && session === "closed" ? "closed" : "unavailable";
  if (stamp.freshness === "paused") return "paused";
  if (connection === "updating") return "updating";
  if (stamp.quality === "fallback") return "backup";
  if (session === "pre") return "pre_market";
  if (session === "after") return "after_hours";
  if (stamp.freshness === "closed" || session === "closed") return "closed";
  return stamp.freshness === "live" ? "live" : "delayed";
}

export function resolveFreshness(input: FreshnessInput): FreshnessView {
  const state = freshnessState(input);
  const asOf = followFeed(input)?.as_of ?? null;
  const now = input.now ?? new Date();
  const ago = formatAgo(asOf, now);
  const label = fill(COPY[state], {
    time: state === "reconnecting" ? formatEtClock(asOf) : formatEtTimeZone(asOf),
    ago,
  });
  const stale = state === "paused" || state === "reconnecting";
  return {
    state,
    label,
    tone: TONE[state],
    dot: state === "live",
    dim: stale || state === "unavailable",
    stale,
    mark: stale ? fill(COPY.staleMark, { ago }) : null,
  };
}

const SOURCE_LABELS: Record<string, string> = { alpaca: "Alpaca", ibkr: "IBKR", mixed: "Alpaca + IBKR" };
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "No source";
  return SOURCE_LABELS[source] ?? source;
}

/** Status-bar text: "Quotes live · IBKR", "Quotes: Alpaca · Delayed 15 min" (02l §b2). */
export function statusBarText(input: FreshnessInput): string {
  const view = resolveFreshness(input);
  const source = sourceLabel(input.stamp?.source);
  if (view.state === "live") return `Quotes live · ${source}`;
  if (view.state === "delayed") return `Quotes: ${source} · ${COPY.delayed}`;
  if (view.state === "closed") return input.stamp?.source ? `Quotes: ${source} · Market closed` : view.label;
  return view.label;
}

const QUALITY_PHRASE: Record<Stamp["quality"], string> = {
  realtime: "Live",
  "delayed-15m": "Delayed 15 min",
  eod: "End of day",
  fallback: "Backup source",
  unavailable: "Unavailable",
};

export const qualityPhrase = (quality: Stamp["quality"]): string => QUALITY_PHRASE[quality];

/** The dated line under a technical board (02l §a: "As of last close · Fri 2026-10-23 · 4:00 PM ET · Alpaca"). */
export function asOfLine(stamp: Pick<Stamp, "freshness" | "quality" | "as_of" | "source"> | null): string {
  if (!stamp?.as_of) return "No update yet";
  const source = stamp.source ? sourceLabel(stamp.source) : null;
  if (stamp.freshness === "closed") return formatLastCloseLine(stamp.as_of, source);
  return [`As of ${formatAsOfText(stamp.as_of)}`, QUALITY_PHRASE[stamp.quality], source].filter(Boolean).join(" · ");
}

/** D11 market-data rows: "Quotes: Alpaca · Delayed 15 min". */
export function marketDataLine(kind: "Quotes" | "Scans", stamp: Pick<Stamp, "source" | "quality"> | null): string {
  if (!stamp) return `${kind}: Unavailable`;
  // A feed that has not run yet has no source to name; "No source · Unavailable" read as broken beside live charts.
  if (stamp.quality === "unavailable") return kind === "Quotes" ? COPY.quotesNotYet : COPY.scansNotYet;
  return `${kind}: ${sourceLabel(stamp.source)} · ${QUALITY_PHRASE[stamp.quality]}`;
}

/** The market-status pill in the top bar. */
export function marketPillText(session: MarketSession, nextOpen: string | null): string {
  if (session === "regular") return COPY.marketOpen;
  if (session === "pre") return COPY.marketPre;
  if (session === "after") return COPY.marketAfter;
  return nextOpen ? fill(COPY.marketClosedOpens, { time: formatEtWeekdayTime(nextOpen) }) : "Market closed";
}

/** The market pill's dot is green only while the session is open and the quotes are not stale: "Market open" beside "Quotes paused" must not look live. */
export function marketPillOpen(session: MarketSession, quotes: Pick<FreshnessView, "stale">): boolean {
  return session === "regular" && !quotes.stale;
}

/** The pill at the 1180 band: just the session word, the full text moves to a tooltip. */
export function marketPillShort(session: MarketSession): string {
  return session === "regular" ? "Open" : session === "pre" ? COPY.marketPre : session === "after" ? COPY.marketAfter : "Closed";
}

export type MarketPillInput = {
  /** Null until /status answers. */
  market: { session: MarketSession; next_open: string | null } | null;
  quotes: FreshnessInput["stamp"];
  connection: Connection;
  /** The first /status load failed and there is nothing to show. */
  failed: boolean;
  band: ShellBand;
  now?: Date;
};

/** Everything the top-bar market pill shows, decided here: whole text (its title), the text on screen, the green dot and the stale mark. */
export function marketPillView({ market, quotes, connection, failed, band, now }: MarketPillInput): { full: string; shown: string; open: boolean; stale: boolean } {
  const full = failed ? "Market status unavailable" : market ? marketPillText(market.session, market.next_open) : "Checking the market…";
  // The quote badge beside the pill already says "Market closed": the pill drops that prefix and keeps what is new, when it opens (D-107).
  const shown = market && band === "1180" ? marketPillShort(market.session) : full.replace(/^Market closed · (.)/, (_, first: string) => first.toUpperCase());
  // "Market open" is true of the market, not of the numbers: the dot goes green only while the quotes are current too (V-Today-01).
  const feed = resolveFreshness({ stamp: quotes, session: market?.session, connection, feed: true, now });
  return { full, shown, open: market !== null && marketPillOpen(market.session, feed), stale: market?.session === "regular" && feed.stale };
}

export type AlertsRuntimeState = "running" | "paused_no_quotes" | "paused_by_user" | "not_started";
/** The banner above alert screens, or null while alerts run. */
export function alertsBanner(state: AlertsRuntimeState): string | null {
  switch (state) {
    case "paused_no_quotes": return COPY.alertsPaused;
    case "paused_by_user": return COPY.alertsPausedByUser;
    case "not_started": return COPY.alertsNotStarted;
    case "running": return null;
  }
}

export function emptyScanText(nextRunAt: string | null): string {
  return nextRunAt ? fill(COPY.emptyScan, { time: formatEtTime(nextRunAt) }) : COPY.emptyScanNoTime;
}

export function loadErrorText(subject: string): string {
  return fill(COPY.loadError, { subject });
}

/** "Holdings as of Fri 2026-10-23 close · IBKR Flex" */
export function holdingsFreshText(statementDate: string): string {
  return fill(COPY.holdingsFresh, { day: formatEtDay(statementDate) });
}

/** "Couldn't import holdings · showing Thu 2026-10-22 · Try again"; without an older statement, no "showing". */
export function holdingsImportFailedText(statementDate: string | null): string {
  return statementDate ? fill(COPY.holdingsImportFailed, { day: formatEtDay(statementDate) }) : COPY.holdingsImportFailedNoData;
}

/** "Desk AI view from Thu · today's update didn't finish" */
export function deskAiStaleText(day: string): string {
  return fill(COPY.deskAiStale, { day });
}

export function notEnoughHistoryText(timeframe: string): string {
  return fill(COPY.notEnoughHistory, { timeframe });
}

// ---- Practice (replay) lane copy (02o §a5). Same rules as COPY; the banned lists below cover it. ----

export const PRACTICE_COPY = {
  band: "Practice · replay of {day} · nothing here reaches a broker",
  bandHub: "Practice · replay of past days · nothing here reaches a broker",
  bandMarks: "Practice trades are simulated on a finished day · nothing is sent to a broker",
  statusPricesPast: "Prices: Alpaca SIP · past days",
  statusPricesReplay: "Prices: Alpaca SIP · replay",
  statusPricesReplayIex: "Prices: Alpaca IEX · replay",
  statusReplayClock: "Replay clock {time}",
  statusScanAtClock: "The scan runs at the thread clock",
  statusScanned: "Scanned {time}",
  statusJournalLive: "Journal is read live, by ET date",
  statusBalanceAsOf: "Balance as of {day}",
  statusBalanceStart: "Balance at the start · no trade yet",
  statusSignals: "Would-fire signals only · nothing is delivered",
  badge: "Replay · {when}",
  feedSip: "Consolidated tape · all US exchanges",
  feedIex: "IEX prints only · about 4% of volume · bar volume is consolidated",
  fastTape: "Fast tape · showing the latest {shown} of {count} prints",
  quietTape: "No prints in the last 30 s",
  haltedTape: "No prints for {time} · the stock may be halted",
  noTrading: "No trading on {day} · pick a weekday",
  notFinished: "This session isn't finished yet · replay opens at 4:15 PM ET",
  beforeFloor: "Replay goes back to Jan 4, 2016",
  loadingReplay: "Preparing the replay…",
  ready: "Paused at {time}",
  playing: "Playing at {speed}x",
  paused: "Paused at {time}",
  advanceError: "Couldn't load the next minute · Try again",
  orderError: "Couldn't place that order · Try again",
  cancelError: "Couldn't cancel that order · Try again",
  notesError: "Couldn't save your notes · Try again",
  undone: "Practice mark removed",
  orderFilled: "Working order filled at {price}",
  undoTooLate: "Can't undo · the playhead has moved",
  nothingToUndo: "No practice mark to undo",
  priceFootnote: "Practice prices are replayed last prices · no spread, slippage, or fees",
  // The lane's chart and ticket (ADR-0025): a lane is a chart of the thread's time; a position and a working order stay as they are when time moves.
  ticketTif: "Time in force",
  positionStopCrossed: "Stop crossed {time} · the position stays open",
  laneBehind: "{symbol} is behind the thread clock, {clock} · catch up to trade it. What happened meanwhile is on the chart and is not scored.",
  laneMarkBehind: "{symbol} is behind the thread clock · catch up before you place an order on it",
  markThreadClosed: "This thread is closed · nothing more to order",
  noSignalsYet: "No signals yet",
  adherenceHint: "Add a plan to get an adherence score",
  loadError: "Couldn't load this session · Try again",
  savingNotes: "Saving notes…",
  notesSaved: "Notes saved",
  planFilters: "Filters",
  planFiltersEmpty: "No filters found · save one in the Screener first",
  planInterval: "Chart interval",
  indicatorsTitle: "Technical indicators",
  indicatorsFootnote: "Read from the bars shown on the chart, up to the replay time. Nothing here looks ahead. VWAP is the session's, from 1-minute bars, on every chart interval.",
  // The Daily rail has no VWAP row, so its note stops before the VWAP sentence (D-203).
  indicatorsFootnoteDaily: "Read from the bars shown on the chart, up to the replay time. Nothing here looks ahead.",
  replayCatchUp: "Catch up",
  markEnded: "This session has ended · nothing more to order",
  dismissMessage: "Dismiss message",
  stopLabel: "Stop loss",
  stopNeeded: "Stop loss: a number above 0",
  noteLabel: "Note",
  ordersEarlier: "Show {count} earlier",
  ordersFewer: "Show fewer",
  signalUnseen: "not scored · fired while you were on another name",
  // The Screen (ADR-0025): her saved filters scanned at the thread's time T. It has no list time, no day number and no review.
  screenTitle: "Screen · {day}",
  screenBadge: "Practice Screen",
  screenLoading: "Reading the Screen…",
  screenLoadError: "Couldn't load the Screen · Try again",
  screenLiveError: "Couldn't read the prices at the clock · Try again",
  screenPickHint: "Pick a thread to open its Screen.",
  screenNoSetup: "This thread has no setup yet",
  screenNoSetupHint: "The Screen holds your saved filters. Set the thread up on its Summary to get one.",
  screenToSummary: "Go to the Summary",
  screenCounts: "{scanned} of {size} scanned · {matched} matched · showing {shown}",
  screenNotScanned: "Not scanned yet",
  screenNoScanTitle: "No scan yet",
  screenNoScanHint: "Scan runs your saved filters at the thread clock, {clock}, on the data you could have seen by then.",
  screenFiltersNote: "Saved filters · a name that passes either one is listed",
  screenFiltersNoteOne: "Saved filters",
  screenUniverse: "Universe: today's Desk set, up to {max} names by today's dollar volume ({size} names here). It can differ from the names that traded then.",
  screenSource: "Source: Alpaca SIP bars up to {through} · nothing after the scan time is shown",
  screenNoNamesTitle: "No name matched your filters at this time",
  screenNoNamesHint: "Move the clock and scan again, or widen a filter in the Screener.",
  screenOpenHint: "Click a name to open its chart at the thread clock, {time}. What it did earlier is on its chart and is not scored.",
  screenLiveNote: "Columns marked \"now\" follow the thread clock, {clock}, and nothing later than it. The rest are fixed at the {scan} scan: price at scan, prev close, since, ATR %, RSI and earnings.",
  screenLiveNotePre: "Price now follows the thread clock, {clock}. Every other column is fixed at the {scan} scan until the market opens.",
  screenLiveNoteOpen: "Price now follows the thread clock, {clock}. Every other column is fixed at the {scan} scan.",
  screenPriceAtScan: "Price at scan",
  screenOpenButton: "Open",
  screenOpen: "Open {symbol}",
  screenOpening: "Opening {symbol}…",
  screenOpenError: "Couldn't open that name · Try again",
  screenPeek: "Peek",
  screenPeekAt: "Peek at {symbol}",
  screenPeekClose: "Close",
  screenStar: "Star {symbol}",
  screenUnstar: "Unstar {symbol}",
  screenStarButton: "Star",
  screenStarredButton: "Starred",
  screenUnstarButton: "Unstar",
  screenStatusNotScanned: "Not scanned yet",
  screenStarError: "Couldn't save your stars · Try again",
  screenYourNames: "Your names",
  screenLanes: "Names you opened",
  screenLanesEmpty: "No name opened yet · click a name above to open its chart",
  screenLaneFlat: "Flat",
  screenLaneBehind: "Chart behind the clock · catches up when opened",
  screenContinue: "Continue on {symbol}",
  screenRiskFrom: "Risk plan comes from the thread: {plan}.",
  screenRiskNone: "Risk plan comes from the thread: no limits set",
  screenRescanTitle: "Scan at the thread clock",
  screenScanNow: "Scan now",
  screenRescanNow: "Re-scan now",
  screenRescanHint: "Runs your filters at the thread clock, on the data you could have seen by then, and replaces the names above with the result. Names you opened or starred stay.",
  screenRescanCurrent: "The names above already come from a scan at the thread clock · move the clock to scan again",
  screenRescanClosed: "This thread is closed · its Screen no longer scans",
  screenRescanLabel: "Scan {seq} · run at {clock} · data through {through}",
  screenRescanCounts: "{shown} of {matched} matched · {fresh} new in this scan",
  screenRescanKept: "{held} kept because you opened or starred them",
  screenRescanStale: "The thread clock is now {clock} · this scan is older. Re-scan to update it.",
  screenRescanNew: "New in this scan",
  screenRescanHeld: "No longer matches",
  screenRescanError: "Couldn't scan · Try again",
  screenRescanning: "Scanning…",
  screenRescanCounting: "Scanning at {clock} · counting the names to read…",
  screenRescanProgress: "Scanning at {clock} · read {done} of {total} names ({pct}%)",
  screenRescanFiltering: "Scanning at {clock} · applying your filters to {total} names…",
  screenRescanProgressLabel: "Scan progress",
  screenRescanDone: "Scan finished · the names above are scan {seq}",
  screenPeekToday: "Up to the scan",
  screenPeekLevels: "Key levels",
  screenPeekMinutes: "Premarket bars through the scan's data time",
  screenPeekDaily: "Daily bars on the same share basis as the scan",
  screenPeekPrice: "Scan price",
  screenPeekPrevClose: "Prev close",
  screenPeekVsPrev: "Scan price vs prev close",
  screenPeekEarnings: "Earnings",
  screenPeekEarningsFlagged: "Reported before the open",
  screenPeekEarningsNone: "None flagged before the open",
  screenReported: "Reported before the open",
  screenEarningsNone: "None",
  threadsLoading: "Loading your practice threads…",
  threadsLoadError: "Couldn't load your practice threads · Try again",
  threadSimulated: "Simulated",
  threadActive: "Active",
  threadClosedBadge: "Closed",
  threadSwitcher: "Your threads",
  threadBalance: "Balance",
  threadWinRate: "Win rate",
  threadStartedWith: "Started with {start} · {change} so far",
  threadStartedFlat: "Started with {start} · no change yet",
  threadShares: "Shares per trade",
  threadSharesNotSet: "Not set",
  threadSharesPlaceholder: "Optional · tickets open at 100",
  threadPlanNoteNone: "None",
  threadPickTitle: "No practice thread selected",
  // Each screen that lists the threads names its own next step (D-183); the rows go to the same place.
  threadPickHintThread: "Pick a thread to open its Summary.",
  threadPickHintReplay: "Pick a thread, then open a name from its day.",
  threadPickNone: "No practice thread yet · start one on Practice to get a pretend balance",
  threadBalanceLine: "Thread balance {balance}",
  threadJournal: "Open journal",
  threadNewTitle: "New thread",
  threadBalanceHint: "Pretend dollars, from 1,000 to 10,000,000",
  threadStartingBalance: "Starting balance",
  threadSignalOnly: "Trade only on a signal",
  threadMaxLoss: "Max loss ($)",
  threadMaxTrades: "Max trades",
  threadPlanNote: "Plan note",
  threadSubmitHint: "Starts with a pretend {balance}. You can change the plan later.",
  threadNone: "No practice thread yet · start one to get a pretend balance",
  threadClosedTitle: "This thread is closed",
  threadClosedBody: "Its journal and final balance stay here. Start a new thread to keep practicing.",
  threadStartNew: "Start a new thread",
  threadTileTrades: "practice trades",
  threadTileNoTrades: "no wins or losses yet",
  threadTileOfTrades: "{wins} of {trades} trades",
  threadTilePerWin: "per winning trade",
  threadTilePerLoss: "per losing trade",
  journalThreadLoading: "Loading your thread…",
  journalThreadLoadError: "Couldn't load this thread · Try again",
  balanceNow: "Balance now",
  curveStart: "Starting balance",
  summaryTitle: "Summary so far",
  legendTitle: "How to read the charts",
  threadPlanTitle: "Thread plan",
  threadTime: "Thread time",
  replayTime: "Replay time",
  clockTitle: "Thread clock",
  clockHint: "Real time, shifted: the clock keeps its gap to now through the close, after-hours, the night and the weekend. It runs on the server, so leave this screen or sign out and it keeps going. Only Pause, a faster speed, Next open and Jump change it. Your positions and orders stay as they are.",
  clockStateRunning: "Running at {speed}x",
  clockStatePaused: "Paused",
  // The clock reached the latest time the data covers and stopped there (the horizon).
  clockStateHorizon: "Paused at the latest available data",
  clockHorizonNote: "The clock is at the latest time the data reaches ({horizon}). It moves again when newer data exists.",
  clockNotStarted: "This thread has no start time yet. Set one to get a clock.",
  // Next open: a Jump to the first 9:30 ET open after the clock. Positions and orders stay open and are priced at the new time.
  clockNextOpen: "Next open",
  clockNextOpenAt: "Next open · {when}",
  clockNextOpenNone: "No later open yet · the data does not reach another open",
  clockNextOpenStays: "{count} open positions stay open and are priced at the new time.",
  clockNextOpenStaysOne: "1 open position stays open and is priced at the new time.",
  clockPlay: "Play",
  clockPause: "Pause",
  clockJump: "Jump to a date and time",
  clockJumpDate: "Date (ET)",
  clockJumpTime: "Time (ET)",
  clockJumpGo: "Jump",
  clockJumping: "Jumping…",
  clockJumpingNote: "Jumping the clock. A jump across several days prices every position at the new time, so it can take a moment.",
  clockJumpHint: "Forward only, up to {horizon}. Your open positions and working orders stay as they are; a resting order fills if the price crossed it on the way.",
  clockJumpBack: "That time is not ahead of the clock · Jump goes forward only",
  clockJumpPastHorizon: "The data reaches {horizon} · pick an earlier time",
  clockJumped: "Jumped to {when}.",
  clockLoadError: "Couldn't read the thread clock · Try again",
  clockLoading: "Reading the thread clock…",
  clockFrozen: "Held at {time}, the last time the server confirmed the clock. It can't be read right now · trying again.",
  chartNotUpdating: "Not updating · last data {when}",
  marketClosed: "Market closed · data through {time}",
  marketNextOpen: "Next session data starts {when}",
  clockPausedHint: "Paused: the clock does not move until you press Play.",
  clockActionError: "That didn't go through · try again",
  clockAccountBalance: "Balance",
  clockAccountOpen: "Open P/L",
  clockAccountEquity: "Equity",
  clockAccountBuyingPower: "Buying power",
  clockAccountHint: "Balance is what you have realized. Equity adds every open position at the clock's price, and it moves as the clock does. Buying power is the cash an order can use: the balance less what open positions cost and what working orders hold back.",
  buyingPowerLine: "{label} {amount} · simulated cash an order can use",
  chartClockLink: "Resume on the Summary",
  chartClockLinkControls: "Clock controls on the Summary",
  threadEditPlan: "Edit plan",
  threadSavePlan: "Save plan",
  threadPlanSaveError: "Couldn't save the plan · Try again",
  threadClose: "Close thread",
  threadCloseReason: "Reason: closing ends the practice record only. No real account is touched.",
  threadCloseConfirm: "Close this thread",
  threadCloseKeep: "Keep it open",
  threadCloseError: "Couldn't close the thread · Try again",
  // Practice hub (02r2): the landing table and the thread page
  landingColThread: "Thread",
  landingColAction: "Action",
  landingTableLabel: "Practice threads",
  landingJournal: "Trades",
  // ---- the freestyle hub (ADR-0025): the thread card, the New thread form, the Summary and the Portfolio. A thread is a paper account with one clock. ----
  threadsHintFreestyle: "A thread is a pretend account with one clock. Move time forward and your positions stay open, priced at the new time",
  threadSlots: "Thread slots {active} of {max}",
  threadSlotsFull: "All {max} thread slots are in use · close a thread to start another",
  landingColClock: "Thread time",
  landingColBalance: "Balance",
  landingColPositions: "Open positions",
  landingColActivity: "Last activity",
  landingNoClock: "No start time yet",
  landingNoActivity: "No activity yet",
  landingOpenScreen: "Open Screen",
  threadPositionsNone: "No open positions",
  threadPositionsOne: "1 open position",
  threadPositionsMany: "{count} open positions",
  newPlanStartThread: "Start thread",
  newThreadTitle: "New thread",
  newThreadIntro: "A thread is a pretend account with one clock. Pick when it starts, then move time forward: Play, a faster speed, Next open or Jump. Your positions stay open as time moves and are priced at the new time.",
  newThreadFiltersHint: "Your filters build the Screen at the thread's time. Pick up to {max}.",
  newThreadSettings: "Start and chart",
  newThreadStartDay: "Start date",
  newThreadStartTime: "Start time (ET)",
  newThreadStartNote: "The thread opens at this date and time and only moves forward. The default is the 9:30 AM ET open.",
  newThreadListSize: "Screen size",
  newThreadRisk: "Risk rules (optional)",
  newThreadRiskHint: "Optional limits, counted for each ET date of the thread's clock. Leave them empty for none.",
  newThreadSubmitting: "Starting…",
  newThreadFilterFirst: "Pick at least one filter to start a thread",
  newThreadSlowStart: "Still starting · loading the first bars can take a minute or two",
  newThreadError: "Couldn't start the thread · Try again",
  // The Summary (/practice/thread?id=): one next step, the clock, the results by ET date.
  overviewOpenScreen: "Open Screen",
  overviewStepTitle: "Trade",
  overviewStepLine: "Open the Screen to pick a name and trade it. Time moves on the clock below, and a position stays open as it does.",
  overviewStepNoClock: "This thread has no start time yet, so it has no clock.",
  overviewStepClosed: "This thread is closed. Its positions stay open, priced at the time it stopped, and its journal and final balance stay here.",
  overviewAtClock: "At {time}",
  overviewResultsTitle: "Results by date",
  overviewResultsCaption: "Realized results by ET date",
  overviewResultsNone: "No trade closed yet · results appear here by ET date",
  overviewStatsTitle: "Trades so far",
  overviewStatClosed: "Closed trades",
  overviewStatWins: "Wins",
  overviewStatLosses: "Losses",
  overviewStatOpen: "Open positions",
  overviewSinceStart: "Since start {amount}",
  // The Portfolio tab: the positions across the thread's lanes, priced at the clock.
  portfolioTitle: "Portfolio",
  portfolioEquity: "Equity {amount}",
  portfolioTable: "Open positions",
  portfolioEmpty: "No open positions · open a name from the Screen to trade it · closed trades are in Trades",
  portfolioNotStarted: "This thread has no start time yet, so it holds nothing.",
  portfolioLoadError: "Couldn't read the portfolio · Try again",
  portfolioLoading: "Loading the portfolio…",
  portfolioAsOf: "priced at {time}",
  portfolioNotUpdated: "last read {time} · couldn't update, trying again",
  portfolioTotal: "Open P/L",
  portfolioOpen: "Open {symbol}",
  portfolioExit: "Exit {symbol}",
  portfolioExitButton: "Exit",
  portfolioSideLong: "Long",
  portfolioSideShort: "Short",
  portfolioHeldUnderMinute: "under a minute",
  portfolioNoPrice: "no price yet · carried at cost",
  portfolioPriceAge: "last price {age} old",
  portfolioStopCrossed: "Stop crossed {when}",
  portfolioOrdersTitle: "Working orders",
  portfolioOrdersNone: "No working orders",
  portfolioOrderUntil: "until {when}",
  portfolioReduceOnly: "Reduce only",
  portfolioTifGtc: "GTC",
  portfolioTifDay: "Day",
  portfolioPricedAt: "Positions stay open through the close, the night and the weekend. Each is priced at the thread's time.",
  // Delete a thread.
  threadDeleteBodyFreestyle: "Its positions, trades and SIMULATED history are removed. This can't be undone.",
  newPlanClose: "Close",
  newPlanDiscardTitle: "Discard your changes?",
  newPlanDiscardKeep: "Keep editing",
  newPlanDiscard: "Discard",
  newPlanFooter: "Nothing reaches a broker · All money is simulated",
  threadDelete: "Delete",
  threadDeleteConfirm: "Delete thread",
  threadDeleteKeep: "Keep",
  threadDeleting: "Deleting…",
  threadDeleteError: "Couldn't delete this thread · Try again",
  threadPageBack: "Practice",
  tabsLabel: "Practice thread sections",
  tabSummary: "Summary",
  tabPortfolio: "Portfolio",
  tabScreen: "Screen",
  tabJournal: "Trades",
  // The Fills panel of the thread's Trades screen: every Buy and Sell of a thread.
  fillsTitle: "Fills",
  fillsCaption: "Fills, newest first",
  fillsEmpty: "No fills yet · every Buy and Sell is listed here",
  fillsLoading: "Loading the fills…",
  fillsLoadError: "Couldn't load the fills · Try again",
  fillsMore: "Showing the newest {shown} of {total}",
  // The journal under the freestyle model (ADR-0025): read live, grouped by ET date. A date is a label; nothing ends or resets at one.
  fillsDate: "ET date",
  journalCurveTitle: "Balance after each ET date",
  journalCurveHint: "Dollars · red shading = below the starting balance · one point per ET date with a closed trade · open positions are not in it until you close them",
  journalCurveAfter: "After {date} {balance}",
  journalBarsTitle: "Result of each ET date",
  journalBarsHint: "Dollars gained or lost per ET date · green = won · red = lost",
  journalBarsSummary: "Result of each ET date: {won} won, {lost} lost.",
  journalSummaryHint: "Wins and losses count closed practice trades · open positions are in the Portfolio",
  journalTileDates: "with a closed trade",
  journalTileNoLoss: "{date} · no losing date",
  journalDatesTitle: "ET dates",
  journalDatesHint: "closed trades, pretend dollars",
  journalDatesAll: "All dates",
  journalDatesNone: "No closed trade yet · a date appears after you close a position",
  journalLegendWon: "An ET date you won",
  journalLegendLost: "An ET date you lost",
  journalEmptyLine: "{balance} · no closed trade yet",
  journalEmpty: "The balance curve starts after you close your first position.",
  journalOpenPositions: "{positions} · not in this balance until you close them",
  journalOpenPortfolio: "See the Portfolio",
  journalClosedBanner: "This thread is closed · realized balance {balance} · its journal stays here",
  journalStartedDate: "First trade {date}",
  journalDatesTraded: "{count} ET dates with a closed trade",
  journalDatesTradedOne: "1 ET date with a closed trade",
  journalMaxLossRow: "Max loss, pretend dollars per ET date",
  journalMaxTradesRow: "Max trades per ET date",
  journalPlanCaption: "Applies from the next name you open",
  journalPlanApplies: "A change applies from the next name you open (the next lane). A lane already open keeps the plan it began with.",
  journalCloseCaption: "Closing keeps this journal and the realized balance, cancels your working orders and stops the clock where it is. A closed thread can't be reopened. Start a new thread to keep practicing.",
  journalCloseKeeps: "Open positions are not sold: they stay open and are valued at the clock's last time.",
  journalNoTrades: "No practice trades on this name yet",
  journalNoTradesSignals: "No practice trades on this name yet · {signals} would have fired",
  journalLaneLive: "This lane is live · totals follow the thread clock and nothing after it is shown",
  journalNoSignals: "No signals have fired on this name yet",
  journalOpenChart: "Open chart",
  journalOpenScreen: "Open the Screen",
  journalNotes: "Notes",
  journalNoPlanRule: "No plan rule applies to this name",
  backToPractice: "Back to practice",
  threadPageNotFound: "That practice thread was not found · open one from Practice",
  threadPageLoadError: "Couldn't load this practice thread · Try again",
  threadPageLoading: "Loading your practice thread…",
  threadStartedOpen: "Started with {start} · realized {realized} · open P/L {open}",
  threadDeleteTitleNamed: "Delete {name}?",
  threadDeleted: "Deleted {name}",
  notesUnsaved: "Not saved yet",
  sessionNotFound: "That practice session was not found · open one from Practice",
  landingStartFirst: "Start your first practice thread",
  openPractice: "Open Practice",
  threadOpenJournal: "Open journal",
} as const;

/**
 * The Practice lane speaks broker words now (order, position, fill): its ticket is a broker ticket and its orders are
 * simulated against a replayed day. What stays banned is the desk-wide list of technical words that must never reach
 * the screen (`BANNED_TERMS`). The name is kept for the many copy tests that call it.
 */
export function containsPracticeBannedTerm(text: string): boolean {
  return containsBannedTerm(text);
}

type PracticeKey = keyof typeof PRACTICE_COPY;
/** Whole percent of a prepare run that is done (0 when nothing is counted yet). */
export const prepPercent = (done: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((100 * done) / total)) : 0);

export const practiceText = (key: PracticeKey, values: Record<string, string | number> = {}): string =>
  fill(PRACTICE_COPY[key], Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])));

/** A message line has no Try again button: the copy keeps its sentence and drops the " · Try again" tail that only an error block with a retry button can honour. */
export const withoutRetryHint = (text: string): string => text.replace(/ · Try again$/, "");

/** "Practice · replay of Fri 2026-10-23 · nothing here reaches a broker"; `day` null on the hub and on the journals of whole threads. */
export function practiceBandText(day: string | null): string {
  return day ? practiceText("band", { day: formatEtDay(day) }) : PRACTICE_COPY.bandHub;
}

/** The top-bar badge during a replay: "Replay · Fri 2026-10-23 · 1:22:24 AM ET", the thread clock's own date (it can be the day after the session day). */
export function replayBadgeText(playhead: string | null): string {
  return practiceText("badge", { when: formatEtDateClock(playhead) });
}
