import type { Tone } from "../../components/ui/tone.ts";
import type { Stamp } from "../api/schemas.ts";
import type { ShellBand } from "./viewport.ts";
import { formatAgo, formatAsOfText, formatEtClock, formatEtDay, formatEtTime, formatEtTimeZone, formatEtWeekdayTime, formatLastCloseLine } from "./format.ts";

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
  noSignalsToday: "No signals yet today · your strategies are watching",
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
  band: "Practice · replay of {day} · nothing here reaches IBKR",
  bandHub: "Practice · replay of past days · nothing here reaches IBKR",
  bandHidden: "Practice · replay of a hidden day · nothing here reaches IBKR",
  bandHiddenWhy: "Day hidden so it cannot spoil the session",
  bandMarks: "Practice trades are simulated on a finished day · nothing is sent to a broker",
  showDate: "Show date",
  statusPricesPast: "Prices: Alpaca SIP · past days",
  statusPricesReplay: "Prices: Alpaca SIP · replay",
  statusPricesReplayIex: "Prices: Alpaca IEX · replay",
  statusReplayClock: "Replay clock {time}",
  statusDayLists: "Day lists built before the open",
  statusListBuilt: "List built {listAt}",
  statusJournalUpdates: "Journal updates when a day ends",
  statusBalanceAsOf: "Balance as of day {day}",
  statusBalanceStart: "Balance at the start · no day ended yet",
  statusSignals: "Would-fire signals only · nothing is delivered",
  badge: "Replay · {day} · {time}",
  badgeHidden: "Replay · hidden day · {time}",
  hiddenDay: "Hidden day",
  feedSip: "Consolidated tape · all US exchanges",
  feedIex: "IEX prints only · about 4% of volume · bar volume is consolidated",
  fastTape: "Fast tape · showing the latest {shown} of {count} prints",
  quietTape: "No prints in the last 30 s",
  haltedTape: "No prints for {time} · the stock may be halted",
  noTrading: "No trading on {day} · pick a weekday",
  notFinished: "This session isn't finished yet · replay opens at 4:15 PM ET",
  beforeFloor: "Replay goes back to Jan 4, 2016",
  noTradesFor: "No trades for {symbol} on {day}",
  loadingReplay: "Preparing the replay…",
  loadingDays: "Loading practice days…",
  ready: "Paused at {time} · press Space to play",
  playing: "Playing at {speed}x",
  paused: "Paused at {time}",
  sessionOver: "Session over · {trades} · See journal",
  endAndScore: "End and score",
  endEarlyWarning: "Ending now shows the rest of the day in the journal.",
  advanceError: "Couldn't load the next minute · Try again",
  markError: "Couldn't place that mark · Try again",
  markRejected: "That mark wasn't accepted",
  noOpenTrade: "No open practice trade to exit",
  undone: "Practice mark removed",
  orderFilled: "Working order filled at {price}",
  undoTooLate: "Can't undo · the playhead has moved",
  nothingToUndo: "No practice mark to undo",
  stopNeedsTrade: "Open a practice trade before setting a stop",
  priceFootnote: "Practice prices are replayed last prices · no spread, slippage, or fees",
  notableHeader: "Most volatile sessions of the last year for your watchlists · we never show how a day ended",
  notableCustomHint: "Notable days are listed for your watchlist symbols",
  noNotableDays: "No notable days for {symbol} yet",
  noSessions: "No practice sessions yet · pick a day to start",
  noSignalsYet: "No signals yet · your armed strategies are watching",
  noArmed: "No strategies armed · the chart shows only your marks",
  noTradesJournal: "No practice trades this session",
  noTradesJournalSignals: "No practice trades this session · {signals} would have fired",
  adherenceHint: "Add a plan to get an adherence score",
  sessionOpen: "Session still open · Resume",
  loadError: "Couldn't load this session · Try again",
  startError: "Couldn't start the session · Try again",
  savingNotes: "Saving notes…",
  notesSaved: "Notes saved",
  // Daily-list practice (02o-b v1)
  planTitle: "Plan",
  planIntro: "Each day your own filters build a list for the past day you are about to replay. Pick a few names, practice one, then see how every name moved.",
  planNone: "No daily plan yet · set one up to start Day 1",
  planDay: "Day {day} of {of}",
  // D-047: a plan that replaced another starts at its own Day 1, so the thread's day number is the one said: "Day 3" (D-118: one
  // counter, not "Day 3 · plan day 2 of 5"). With no earlier plan the two agree and the line is "Day 2 of 5".
  planDayInThread: "Day {day}",
  planNext: "next: {weekday}",
  planStateInProgress: "in progress",
  planStateListed: "list ready",
  planDayDone: "Day {day} done",
  planDayDoneNext: "Day {done} done · Day {next} next",
  planDone: "All {of} days done",
  planPreparing: "Preparing data · {done} of {total} names",
  planPreparingHint: "The first list opens when the data is ready. You can leave this page.",
  planFailedSome: "{failed} symbols could not be loaded and read as no data",
  planNew: "New plan",
  planReplace: "Start day saves this plan, replaces your current one and opens its first list. Your finished days stay in Recent sessions. A new plan starts over at its own first day, so it can replay a day you have already practised.",
  planStartError: "Couldn't open the list · Try again",
  planFilters: "Filters",
  planFiltersEmpty: "No filters found · save one in the Screener first",
  planFiltersMax: "Pick one to three filters",
  planListAt: "List time",
  planListSize: "List size",
  planStartDay: "First day",
  planSubmit: "Start day",
  planSubmitting: "Starting…",
  planOpening: "Opening the day…",
  // D-058, D-059: the day or the scan outlasted the gateway's wait; the Desk is still finishing it and the screen asks again.
  planStillWorking: "Still preparing your day · this can take a minute or two",
  planSaveFilterFirst: "Pick at least one filter to start a day",
  planListAtNeeds: "{filters} needs a list time of {time} or later · before then none of its bars of the day has closed",
  planArmed: "Armed on practice days: {names}",
  planArmedNone: "Nothing armed · no would-fire signals while you practice",
  planDays: "Days",
  planHideDates: "Hide dates",
  planHideDatesHint: "Hides the calendar dates, so you cannot tell which day you are practicing until you finish it",
  planListAtHint: "Your list for the day is built at this time, from what had happened by then",
  planInterval: "Chart interval",
  planWindowFrom: "Window from (ET)",
  planWindowTo: "Window to (ET)",
  dayLoading: "Building the list…",
  dayLoadError: "Couldn't load this day · Try again",
  dayNoPlan: "No practice day selected",
  dayHeader: "List at {listAt} from data through {through} · {scanned} of {size} scanned · {matched} matched, showing {shown}",
  dayCounts: "{scanned} of {size} scanned · {matched} matched · showing {shown}",
  dayListBuilt: "List built at {listAt} from data through {through}",
  dayDateHidden: "Date hidden",
  dayFiltersNote: "Chosen at setup · a name that passes either one is listed",
  dayFiltersNoteOne: "Chosen at setup",
  dayUniverse: "Universe: today's Desk set, up to {max} names by today's dollar volume ({size} names here). It can differ from the names that traded on that day.",
  daySource: "Source: Alpaca SIP bars up to {through} · nothing after the list time is shown",
  dayNoNames: "No name passed your filters on this day · widen a filter, or end the day to open the next",
  dayBlockTitle: "This block · {of} days",
  dayLadderEnded: "Ended · review",
  dayLadderOpen: "Open now",
  dayLadderOpensAfter: "Opens after day {day}",
  dayLadderLocked: "Locked",
  dayThreadBox: "Balance, today and the risk plan",
  dayRiskFrom: "Risk plan comes from the thread: {plan}.",
  dayRiskNone: "Risk plan comes from the thread: no limits set",
  dayStar: "Star {symbol}",
  dayUnstar: "Unstar {symbol}",
  dayRemove: "Remove {symbol} from your names",
  dayWatch: "Your names",
  dayWatchEmpty: "Star names to keep them in view",
  dayPractice: "Practice {symbol}",
  daySwitch: "Switch to {symbol}",
  dayOnNow: "On now",
  dayBehind: "Behind the clock",
  daySwitchHint: "A name opens at the day clock, {time}. What it did earlier is on its chart and is not scored.",
  dayPortfolio: "Portfolio",
  dayPortfolioEmpty: "Click a name in Candidates to open its chart · it joins your portfolio",
  dayPortfolioTotal: "Day P/L",
  dayPortfolioSplit: "realized {realized} · open {open}",
  dayOpenHint: "Click a name to open its chart and practice it · your first name starts the day",
  dayOpenRelistHint: "Click a name to open its chart and practice it · your first name starts the day · re-list first if you want a later list time",
  dayOpen: "Open {symbol}",
  dayOpening: "Opening {symbol}…",
  dayPeekAt: "Peek at {symbol}",
  dayPortfolioOpenOf: "{open} open",
  dayPortfolioAsOf: "as of {time}",
  dayPortfolioExit: "Exit {symbol}",
  dayPortfolioLast: "last {price}",
  dayPortfolioRealized: "realized {amount}",
  dayStopCrossed: "Stop crossed {time}",
  dayStripNone: "Click a name in Candidates to open its chart",
  replayBehind: "{symbol} is behind the day clock, {clock} · catch up to practice it. What happened meanwhile is on the chart and is not scored.",
  replayCatchUp: "Catch up",
  replayCatchUpError: "Couldn't catch up · Try again",
  signalUnseen: "not scored · fired while you were on another name",
  dayRescan: "Re-scan now",
  dayRescanTitle: "Re-scan at the day clock",
  dayRescanHint: "Runs your filters again at the day clock, on the data you could have seen by then. The list above stays as it was.",
  dayRescanNeedsClock: "Practice a name to start the day clock, then you can re-scan",
  dayRescanLabel: "Scan {seq} · run at {clock} · data through {through}",
  dayRescanCounts: "{shown} of {matched} matched · {fresh} new since your list",
  dayRescanStale: "The day clock is now {clock} · this scan is older. Re-scan to update it.",
  dayRescanNew: "New since your list",
  dayRescanReadOnly: "Names new since your list are for reading: you open names from the list above.",
  dayRescanError: "Couldn't re-scan · Try again",
  dayRescanning: "Re-scanning…",
  dayRescanStillWorking: "Still scanning · this can take a minute or two",
  dayEnd: "End day",
  dayEndWarning: "Ending the day shows how every name moved after the list.",
  dayEndExits: "Ending the day exits {count} open practice {trades} at the price you see now: {names}",
  dayEnded: "Day over",
  dayPeek: "Peek",
  dayPeekNone: "Pick a row to peek at its chart before the open",
  dayPeekMinutes: "Premarket bars through the list's data time",
  dayPeekPrevClose: "Prev close",
  dayPeekVsPrev: "List price vs prev close",
  dayPeekEarnings: "Earnings",
  dayPeekEarningsFlagged: "Reported before the open",
  dayPeekEarningsNone: "None flagged before the open",
  dayPeekDaily: "Daily bars on the same share basis as the list",
  dayPeekToday: "Up to list time",
  dayReported: "Reported before the open",
  dayNoValue: "Not in this list's data",
  dayStartError: "Couldn't start the practice · Try again",
  dayRelistError: "Couldn't re-list the day · Try again",
  dayRelistWindow: "The practice window then starts at {time} ET",
  dayRelistPreparing: "Preparing the Desk universe for this plan · re-list again in a minute",
  reviewTitle: "How the list moved",
  reviewNote: "Moves are from each name's list price, not from the open",
  reviewRankNote: "Ranked by move from list price to window end, biggest gain first",
  reviewDayFinished: "Day finished",
  reviewSelection: "Your names moved {moves} · list median {median} · ranked {ranks} of {of}",
  reviewDayTitle: "Your day",
  reviewDayNone: "No practice trades this day",
  reviewDayHint: "Practice prices to the cent · no spread, slippage, or fees",
  reviewBalance: "Balance {before} → {after}",
  reviewNoPicks: "You did not open a name",
  reviewEmpty: "No moves to show for this day",
  backToList: "Back to the day list",
  dayAfter: "Next day",
  dayAfterOpening: "Opening the next day…",
  dayFinished: "You have finished every day of this plan",
  // Practice threads (02r): the pretend account she practices in across days. Every dollar is SIMULATED.
  threadsTitle: "Your practice threads",
  threadsHint: "A thread keeps its pretend balance from day to day, and on days you pass",
  threadsLoading: "Loading your practice threads…",
  threadsLoadError: "Couldn't load your practice threads · Try again",
  threadSimulated: "Simulated",
  threadActive: "Active",
  threadClosedBadge: "Closed",
  threadSwitcher: "Your threads",
  threadBalance: "Balance",
  threadDaysPracticed: "Days practiced",
  threadSkipped: "Days passed",
  threadWinRate: "Win rate",
  threadAdherence: "Adherence",
  threadAdherenceLast: "last scored day",
  threadAdherenceRange: "first to last scored day",
  threadAdherenceNone: "no scored day yet",
  threadAdherenceMeaning: "Adherence is the share of your plan's rules you followed, not the share of trades you won",
  threadToday: "Today",
  threadLastDay: "Last day",
  threadLastDayLine: "{pnl} realized · {trades}",
  threadLastDaySkipped: "Passed · no practice trades",
  threadStartedWith: "Started with {start} · {change} so far",
  threadStartedFlat: "Started with {start} · no change yet",
  threadShares: "Shares per trade",
  threadSharesPerEntry: "You set it on each entry",
  threadPlanNoteNone: "None",
  threadPickTitle: "No practice thread selected",
  threadPickHint: "Pick a thread to open its journal.",
  threadPickNone: "No practice thread yet · start one on Practice to get a pretend balance",
  threadNoToday: "No practice day open · the next list opens when you resume",
  threadTodayLine: "{pnl} realized so far · {trades}",
  threadBalanceLine: "Thread balance {balance}",
  threadTodayShort: "today {pnl}",
  threadTodayOpen: "{count} open {pnl}",
  threadResumeError: "Couldn't open the list · Try again",
  threadJournal: "Open journal",
  threadNewTitle: "New thread",
  threadBalanceHint: "Pretend dollars, from 1,000 to 10,000,000",
  threadStartingBalance: "Starting balance",
  threadMode: "Mode",
  threadModeDay: "Day trading",
  threadStopOnEntry: "Stop on every entry",
  threadSignalOnly: "Trade only on a signal",
  threadMaxLoss: "Max loss ($)",
  threadMaxTrades: "Max trades",
  threadPlanNote: "Plan note",
  threadSubmit: "Start thread",
  threadSubmitHint: "Starts with a pretend {balance}. You can change the plan later.",
  threadStartError: "Couldn't start the thread · Try again",
  threadNone: "No practice thread yet · start one to get a pretend balance",
  threadClosedTitle: "This thread is closed",
  threadClosedBody: "Its journal and final balance stay here. Start a new thread to keep practicing.",
  threadStartNew: "Start a new thread",
  threadNeeded: "Start a practice thread first · it holds your simulated balance and risk plan",
  threadNeededDay: "Start a day practice thread first · swing threads keep their own calendar",
  threadPlanFrom: "The risk plan comes from your thread",
  threadTileOpened: "of {n} days opened",
  threadTileCarried: "no practice trades",
  threadTileTrades: "practice trades",
  threadTileNoTrades: "no wins or losses yet",
  threadTileOfTrades: "{wins} of {trades} trades",
  threadTilePerWin: "per winning trade",
  threadTilePerLoss: "per losing trade",
  threadTileAdherenceBy: "first to latest scored day",
  journalThreadTitle: "Thread journal",
  journalThreadIntro: "Your pretend balance day by day: how it rose and dipped, which days won or lost, and which days you passed. A day you pass has no practice trades. The balance just carries to the next day you practice.",
  journalThreadLoading: "Loading your thread…",
  journalThreadLoadError: "Couldn't load this thread · Try again",
  journalThreadNone: "No practice thread selected",
  journalThreadClosed: "This thread is closed · final balance {balance} · its journal stays here",
  journalThreadEmpty: "The balance curve starts after your first practice day ends.",
  journalThreadEmptyLine: "{balance} · 0 days practiced",
  balanceNow: "Balance now",
  curveTitle: "Balance at the end of each day",
  curveHint: "Dollars · red shading = below the starting balance · open circle = passed day, balance carries",
  curveStart: "Starting balance",
  barsTitle: "Result of each day",
  barsHint: "Dollars gained or lost per day · green = won · red = lost · dashed box = passed, no practice trades",
  summaryTitle: "Summary so far",
  summaryHint: "Wins and losses count practice trades",
  weeksTitle: "Weeks",
  weeksHint: "day results, pretend dollars",
  weeksAll: "All weeks",
  weeksNone: "No weeks yet · a week appears after your first practice day",
  legendTitle: "How to read the charts",
  legendWon: "A day you won",
  legendLost: "A day you lost",
  legendSkipped: "A day you passed: no practice trades",
  improvementTitle: "Improvement",
  improvementIntro: "First week against the latest week (week {n}, {days} so far).",
  improvementTooFew: "Too few days to call a trend yet",
  improvementReason: "Reason: week {n} has {days} so far. A trend needs at least 2 weeks with 3 or more practice days each.",
  improvementReasonOneWeek: "Reason: improvement compares weeks. It waits for at least 2 weeks with practice days.",
  improvementVerdict: "Week {latest} averaged {latestAvg} a practice day; week {first} averaged {firstAvg}.",
  threadPlanTitle: "Thread plan",
  threadEditPlan: "Edit plan",
  threadPlanCaption: "Applies from your next session",
  threadSavePlan: "Save plan",
  threadPlanApplies: "A change applies from your next session. A session already started keeps its plan.",
  threadPlanSaveError: "Couldn't save the plan · Try again",
  threadClose: "Close thread",
  threadCloseCaption: "Closing keeps this journal and the final balance, and stops new days. A closed thread can't be reopened. Start a new thread to keep practicing.",
  threadCloseReason: "Reason: closing ends the practice record only. No real account is touched.",
  threadCloseConfirm: "Close this thread",
  threadCloseKeep: "Keep it open",
  threadCloseError: "Couldn't close the thread · Try again",
  // Swing practice (02p): a fixed list of names, practice holds that can stay open overnight, and a weekly review.
  // Every dollar is SIMULATED. Dates stay hidden: a day is "Day 7 · Tue", a week is "Week 2".
  swingSimulated: "SIMULATED",
  swingWeek: "Week {n}",
  swingBalance: "Balance {amount}",
  swingEquity: "Equity {amount}",
  swingFreeCash: "Free cash {amount}",
  swingAsOfPriorClose: "as of the prior close",
  swingDayOver: "Day over",
  swingCardNames: "Swing · {n} names",
  swingCardWeek: "Week {week} of {weeks}",
  swingFinished: "Finished · Day {days} of {days}",
  swingNoHoldsOpen: "No holds open",
  swingReviewReady: "Week {n} review ready",
  swingOpenReview: "Open Week {n} review",
  swingStartDay: "Start Day {n}",
  swingContinueDay: "Continue Day {n}",
  swingStartWeek: "Start Week {n}",
  swingPassDay: "Pass this day",
  swingMarketNotOpen: "Market not open yet · step to the first bar",
  swingTapeOff: "Tape off · swing prices are one-minute closes",
  swingTapeOffFootnote: "Swing prices are one-minute closes · turn the tape on for exact prints",
  swingDividends: "Dividends are not credited in practice",
  swingScoredWeekly: "Scored weekly",
  // holds
  swingEntryLabel: "Day {day} · {price}",
  swingDaysHeld: "{n} days held",
  swingDaysHeldOne: "1 day held",
  swingStop: "Stop {price}",
  swingStopCrossed: "Stop {price} crossed",
  swingNoStop: "No stop",
  swingStopAway: "{pct} from your stop",
  swingStopPast: "{pct} past your stop",
  swingStopAt: "At your stop",
  swingPriorClose: "Prior close {price}",
  swingLastPrice: "Last {price}",
  swingLastOneMinute: "Last {price} (1m close)",
  swingGap: "Gap {amount}",
  swingEarnings: "Earnings {when} · {timing}",
  swingExitHer: "Exit Day {day} · {price}",
  swingExitAuto: "Closed at the close of Day {day} · {price}",
  swingBoardHolds: "Practice holds",
  swingBoardNoHolds: "No practice holds open",
  swingBoardUniverse: "Universe",
  swingBoardMatches: "Matches",
  swingBoardStarHint: "Star up to 5 focus names · you can practice your focus names and your holds",
  swingBoardStarFirst: "Star a name to start the day · you can practice your focus names and your holds",
  swingBoardPeek: "Peek shows daily bars through the prior close",
  swingLoadError: "Couldn't load this swing day · Try again",
  swingContinueError: "Couldn't open the next day · Try again",
  swingPrepTooLong: "The next day's data is taking longer than usual · Try again in a few minutes",
  swingEndError: "Couldn't end the day · Try again",
  swingPassError: "Couldn't pass this day · Try again",
  swingStartError: "Couldn't start the day · Try again",
  swingPrepWait: "Preparing the swing data · {done} of {total} ({pct}%)",
  swingPrepWaitHint: "The next day opens when the data is ready. You can leave this page.",
  swingThreadFinished: "Thread finished · every hold closed at the last close",
  // the stop pause and the day strip
  swingPauseCross: "{symbol} crossed your stop {stop} at {time}",
  swingPauseGapBelow: "{symbol} opened below your stop {stop} at {price}",
  swingPauseGapAbove: "{symbol} opened above your stop {stop} at {price}",
  swingPauseAlso: "{names} also crossed",
  swingPauseAction: "Exit or keep",
  swingPauseExit: "Exit {symbol}",
  swingPauseKeep: "Keep the hold",
  swingStripTitle: "Day strip",
  swingStripHold: "{side} {shares} · {pnl} · {stop}",
  swingStripEmpty: "No holds or focus names yet · star up to 5 names on the board",
  // End day and Pass
  swingEndAsk: "End Day {day}?",
  swingEndAskAt: "End Day {day} at {time}?",
  swingEndHolds: "Your {n} holds stay open through the close, unwatched.",
  swingEndOneHold: "Your 1 hold stays open through the close, unwatched.",
  swingEndNoHolds: "The rest of the day is shown at once.",
  swingOvernight: "{n} holds stay open overnight",
  swingOvernightOne: "1 hold stays open overnight",
  swingPassHolds: "Your {n} holds ride through Day {day} unwatched.",
  swingPassOneHold: "Your 1 hold rides through Day {day} unwatched.",
  swingPassNoHolds: "No holds are open, so nothing rides through Day {day}.",
  swingPassed: "Passed",
  swingStopsAway: "{n} while you were away",
  swingStopHitWatched: "{symbol} crossed its stop at {time}",
  swingStopHitAway: "{symbol} crossed its stop at {time} while you were away",
  swingLateStars: "Starred after the open: {names}",
  // the setup section of the New thread form
  swingModeLabel: "Swing",
  swingSetupHint: "Pick the first day and how many days to practice.",
  swingFirstDay: "First day",
  swingSessions: "Sessions",
  swingHideDates: "Hide dates",
  swingCalendarLine: "{sessions} sessions · {weeks} {noun} · ends on day {sessions}",
  swingUniverseSection: "Universe",
  swingWatchlists: "Your watchlists",
  swingAddSymbols: "Add symbols",
  swingAddFromFilter: "Add from a filter",
  swingAddFromFilterHint: "Up to 3 daily filters · their matches as of the close before Day 1",
  swingAddByLiquidity: "Add by liquidity",
  swingAddByLiquidityHint: "The Desk's names ranked by 20-day average dollar volume, above the live floor",
  swingTarget: "Target size",
  swingListOrder: "The list is built from your watchlists, then your adds, then filter matches, then liquidity",
  swingMaxOpen: "Open holds at most",
  swingRiskPerHold: "Risk per hold ($)",
  swingInterval: "Interval",
  swingTape: "Tape",
  swingTapeNo: "Off",
  swingTapeYes: "On",
  swingMaxLossWeek: "Max loss ($ a week)",
  swingMaxTradesWeek: "Max trades a week",
  swingPerWeekNote: "In a swing thread the plan's max loss and max trades count per week",
  swingStartThreadError: "Couldn't start the swing thread · Try again",
  swingPreviewError: "Couldn't build the universe · Try again",
  swingBuildFirst: "Build the universe first",
  swingUniverseNeed: "Pick {min} to {max} names · you have {n}",
  swingWaitForData: "Wait for the data to finish · {done} of {total} ({pct}%)",
  swingNeedMore: "Pick at least {min} symbols · you have {n}",
  swingPrepProgress: "Preparing as-of data · {done} of {total} ({pct}%) · this can take several minutes · watchlist and manual picks are ready",
  swingPrepReady: "As-of data is ready",
  swingBasis: "as of the close before Day 1",
  swingSurvivors: "survivors only",
  swingExcludedRow: "{symbol} · left out · {reason}",
  swingTypeSymbol: "Type a symbol, like NVDA",
  swingNotSymbol: "{symbol} is not a stock symbol",
  swingAlreadyListed: "{symbol} is already on the list",
  swingTooManyEdits: "You can add or remove up to {max} symbols by hand",
  swingFormError: "Check the swing thread and try again",
  swingRangeTooLate: "{sessions} sessions from {day} run past the last finished day · pick an earlier start",
  // the weekly review
  swingWeekToDate: "Week to date",
  swingWeekToDateNote: "Through the last finished day's close · not final yet",
  swingWeekFinal: "Final",
  swingWeekOpen: "Open",
  swingWeekLoadError: "Couldn't load this week · Try again",
  swingWeeksNone: "No weeks yet · a week appears after your first finished day",
  swingWeekNotes: "Week notes",
  swingEquityTitle: "Balance and equity at each close",
  swingDaysTitle: "Days",
  swingHoldsTitle: "Holds this week",
  swingHeatTitle: "The universe this week",
  swingHeatHint: "Best to worst by week return · your holds and focus names are marked",
  swingAdherenceTitle: "Adherence",
  swingFocusTitle: "Starred names you did not hold",
  swingSelectionTitle: "Selection and timing",
  swingTileRealized: "holds closed this week",
  swingTileRealizedSoFar: "holds closed so far",
  swingTileUnrealized: "open holds at the last close",
  swingTileEquityChange: "realized plus unrealized",
  swingTileBalance: "closed holds only",
  swingTileWinLoss: "average win {win} · average loss {loss}",
  swingTileNoClosed: "no holds closed yet",
  swingTileDaysHeld: "closed holds",
  swingTileNoGap: "no carried holds",
  swingTileGapOver: "Over 100%",
  swingTileGapOverSub: "{gap} · more than the week's whole change",
  swingTileAdherence: "plan checks passed",
  swingTileSelection: "vs the universe median",
  swingTileTiming: "your prices vs holding close to close",
  swingTileSpy: "SPY this week",
  swingTileMedian: "median {median}",
  swingNoHoldsWeek: "No holds this week · selection and timing score your holds against the universe",
  swingNoSelection: "Selection and timing need a hold with a full price history",
  swingDayShort: "Day {day} · {weekday}",
  swingOpenClose: "open · {weekday} close",
  swingRank: "{rank} of {of}",
  swingFilterQuality: "Names your filters flagged ({n}): median {median} vs universe median {universe} · edge {edge}",
  swingFocusUntraded: "{symbol} would have ranked {rank} of {of} ({ret})",
  // Practice hub redesign (02r2): the landing table, the New plan modal and the thread page
  landingColThread: "Thread",
  landingColProgress: "Progress",
  landingProgressDay: "Day {n}",
  landingProgressDone: "Day {n} done",
  landingProgressNone: "No day yet",
  landingProgressNoDays: "No days yet",
  landingProgressFinished: "Finished",
  landingProgressClosed: "{n} days",
  landingProgressCounts: "{practiced} practiced · {skipped} passed",
  landingReviewDue: "Week {n} review due",
  landingColLastDay: "Last day",
  landingColAction: "Action",
  landingEquity: "Equity {amount}",
  landingNeedsPlan: "Start a new plan",
  landingNewPlanFor: "New plan for {name}",
    landingTableLabel: "Practice threads",
  landingJournal: "Journal",
  landingStillWorking: "Still preparing your day · this can take a minute or two",
  newPlanTitle: "New plan",
  newPlanClose: "Close",
  newPlanIntroThread: "A practice thread replays past days with a pretend balance that carries from day to day. Pick the filters that build each day's list, then when it runs.",
  newPlanIntroPlan: "Replaces this thread's current daily plan. The balance stays with the thread.",
  newPlanFiltersHint: "Each filter builds your list for a day. Pick up to {max}.",
  newPlanSwingNote: "A swing thread follows one fixed list of names over several weeks, and a hold can stay open overnight. Pick the names and the days.",
  newPlanSettings: "Settings",
  newPlanStart: "Start {days}-day practice",
  newPlanStartBare: "Start practice",
  newPlanStartSwing: "Start {days}-day swing practice",
  newPlanStartSwingBare: "Start swing practice",
  newPlanSubmitting: "Starting…",
  newPlanDiscardTitle: "Discard your changes?",
  newPlanDiscardKeep: "Keep editing",
  newPlanDiscard: "Discard",
  newPlanFooter: "Nothing reaches IBKR · All money is SIMULATED",
  newPlanError: "Couldn't set up the plan · Try again",
  newPlanThreadKept: "Your thread is started · the plan did not save, so try again",
  threadDelete: "Delete",
  threadDeleteBody: "Its days and SIMULATED history are removed. This can't be undone.",
  threadDeleteConfirm: "Delete thread",
  threadDeleteKeep: "Keep",
  threadDeleting: "Deleting…",
  threadDeleteError: "Couldn't delete this thread · Try again",
  threadPageBack: "Practice",
  backToPractice: "Back to practice",
  threadPageNotFound: "No practice thread with that number · open one from Practice",
  threadPageLoadError: "Couldn't load this practice thread · Try again",
  threadPageLoading: "Loading your practice thread…",
  threadPageDay: "Today's day",
  threadPageLastDay: "Last day",
  threadPageWeek: "Week {week} of {weeks}",
  threadPageReplace: "Replace plan",
  threadPageClosed: "This thread is closed. Its journal and final balance stay here.",
  threadPageFresh: "Your thread is ready · Day 1 is next",
  // The thread overview (5R): a dashboard of where the thread is and what comes next. Dates stay hidden: a day is "Day 3 · Wed".
  overviewNext: "Next step",
  overviewReviewStep: "Week {n} review",
  overviewDayLocked: "Week {n} is done. Review it to unlock Day {day}.",
  overviewPlace: "Where you are",
  overviewStats: "Thread stats",
  overviewDaysTitle: "Days",
  overviewDaysCaption: "Days of this thread",
  overviewDaysNone: "No days yet · a day appears here once it ends",
  overviewDayPracticed: "Practiced",
  overviewDaySkipped: "Passed",
  overviewWeeksCaption: "Weeks of this thread",
  overviewWeekDone: "Done",
  overviewWeekReview: "Review due",
  overviewWeekCurrent: "Current",
  overviewWeekUpcoming: "Upcoming",
  overviewHoldsCaption: "Open holds",
  overviewHoldsCount: "{n} open",
  overviewHoldsLink: "See holds in the journal",
  overviewCurveTitle: "Balance over the days",
  overviewPlanTitle: "Plan and universe",
  overviewPlanCaption: "Thread plan",
  // Fix wave 5S, stream 3 (the replay chart and its controls).
  // Fix wave 5S, stream 1 (practice UX): the hub, the day list and the week review.
  threadStartedSwing: "Started with {start} · realized {realized} · open holds {open}",
  planResumeDay: "Resume Day {n}",
  planOpenDay: "Open Day {n}",
  planStartDayN: "Start Day {n}",
  threadDeleteTitleNamed: "Delete {name}?",
  threadDeleted: "Deleted {name}",
  landingColEquityChange: "Equity change",
  summaryHintOpen: "Wins and losses count practice trades · today's day is still open",
  swingHoldDay: "Day {n} of hold",
  notesUnsaved: "Not saved yet",
  dayNotFound: "That practice day was not found · open a day from your thread",
  landingStartFirst: "Start your first practice thread",
  swingWeekFinalHolds: "Final · {n} {noun} open",
  threadOpenJournal: "Open journal",
  dayEndYes: "Yes, end day",
  dayKeepPracticing: "Keep practicing",
  dayFinishPlan: "Finish plan",
  planFinishedSummary: "Plan finished · {days} · {change} · win rate {rate}",
  dayNoMatchTitle: "No name matched your filters on this day",
  dayNoMatchHint: "Skip the day to open the next one, or change the plan's filters.",
  daySkip: "Skip this day",
  dayChangePlan: "Change plan",
  overviewDayPassedHolds: "Passed · holds rode, equity {change}",
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

/** "Practice · replay of Fri 2026-10-23 · nothing here reaches IBKR"; `day` null on the hub, `hidden` while the date is masked. */
export function practiceBandText(day: string | null, hidden = false, pastDays = false): string {
  if (pastDays && hidden) return PRACTICE_COPY.bandHub; // a list or journal of hidden days says "past days" (D-015)
  if (hidden) return PRACTICE_COPY.bandHidden;
  return day ? practiceText("band", { day: formatEtDay(day) }) : PRACTICE_COPY.bandHub;
}

/** The top-bar badge during a replay: "Replay · Fri 2026-10-23 · 10:07 AM ET" or "Replay · hidden day · 10:07 AM ET". */
export function replayBadgeText(day: string, playhead: string | null, hidden: boolean): string {
  const time = formatEtTimeZone(playhead);
  return hidden ? practiceText("badgeHidden", { time }) : practiceText("badge", { day: formatEtDay(day), time });
}
