import type { Stamp } from "../api/schemas.ts";
import { formatAgo, formatAsOfText, formatEtClock, formatEtDay, formatEtTime, formatEtTimeZone, formatEtWeekdayTime, formatLastCloseLine } from "./format.ts";

// The single copy table for freshness, session and empty/error wording (02l §c3, 02m §c3). Components
// never write these strings; they call the functions below. `{x}` marks a value filled at render time.
export const COPY = {
  live: "Live",
  delayed: "Delayed 15 min",
  updating: "Updating quotes…",
  reconnecting: "Reconnecting… · last update {time}",
  paused: "Quotes paused · last update {ago}",
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
  emptyScan: "No matches right now · next scan {time}",
  emptyScanNoTime: "No matches right now",
  loadError: "Couldn't load this {subject} · Try again",
  ordersOff: "Trading is off in the Desk · place orders in IBKR",
  wrongLane: "This screen belongs to the {lane} view",
  switchView: "Switch view",
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
  futuresNotConnected: "Waiting for IBKR · not connected yet",
  futuresReadOnly: "Futures · read only",
  firstScan: "Waiting for the first scan",
  newFilter: "New filter",
  noFilters: "No screener filters yet",
  quotesNotYet: "Quotes: Not updated yet",
  scansNotYet: "Scans: Not run yet",
  stripFirstUpdate: "First market update {time}",
  stripNoData: "No market data yet",
  stripLastClose: "Last close · {time}",
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
export type FreshnessTone = "up" | "muted" | "amber" | "down";
/** Client-side connection state: a request in flight, or the quote connection down (02m §a1). */
export type Connection = "ok" | "updating" | "reconnecting";
export type MarketSession = "pre" | "regular" | "after" | "closed";

export type FreshnessInput = {
  stamp: Pick<Stamp, "freshness" | "quality" | "as_of" | "source"> | null;
  session?: MarketSession;
  connection?: Connection;
  /** The stamp covers the whole data feed (top bar, status bar, Today), not one symbol or one list. */
  feed?: boolean;
  now?: Date;
};

export type FreshnessView = {
  state: FreshnessState;
  label: string;
  tone: FreshnessTone;
  /** A filled dot beside the label (only "Live"). */
  dot: boolean;
  /** The last price stays visible but dimmed. */
  dim: boolean;
};

const TONE: Record<FreshnessState, FreshnessTone> = {
  live: "up",
  delayed: "muted",
  updating: "muted",
  reconnecting: "amber",
  paused: "amber",
  backup: "amber",
  closed: "muted",
  pre_market: "muted",
  after_hours: "muted",
  unavailable: "down",
};

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
export const fillCopy = fill;

export function freshnessState({ stamp, session, connection = "ok", feed = false }: FreshnessInput): FreshnessState {
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
  const asOf = input.stamp?.as_of ?? null;
  const now = input.now ?? new Date();
  const label = fill(COPY[state], {
    time: state === "reconnecting" ? formatEtClock(asOf) : formatEtTimeZone(asOf),
    ago: formatAgo(asOf, now),
  });
  return { state, label, tone: TONE[state], dot: state === "live", dim: state === "reconnecting" || state === "unavailable" };
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

/** The pill at the 1180 band: just the session word, the full text moves to a tooltip. */
export function marketPillShort(session: MarketSession): string {
  return session === "regular" ? "Open" : session === "pre" ? COPY.marketPre : session === "after" ? COPY.marketAfter : "Closed";
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

export function wrongLaneText(lane: string): string {
  return fill(COPY.wrongLane, { lane });
}

export function notEnoughHistoryText(timeframe: string): string {
  return fill(COPY.notEnoughHistory, { timeframe });
}

// ---- Practice (replay) lane copy (02o §a5). Same rules as COPY; the banned lists below cover it. ----

export const PRACTICE_COPY = {
  band: "Practice · replay of {day} · nothing here reaches IBKR",
  bandHub: "Practice · replay of past days · nothing here reaches IBKR",
  bandHidden: "Practice · replay of a hidden day · nothing here reaches IBKR",
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
  tradeAlreadyOpen: "A practice trade is already open · exit it first",
  maxLoss: "Max loss reached · your plan says stop for the day",
  undone: "Practice mark removed",
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
  planTitle: "Daily list practice",
  planIntro: "Each day your own filters build a list for the past day you are about to replay. Pick a few names, practise one, then see how every name moved.",
  planNone: "No daily plan yet · set one up to start Day 1",
  planDay: "Day {day} of {of}",
  planNext: "next: {weekday}",
  planInProgress: "Day {day} of {of} · in progress",
  planDone: "All {of} days done",
  planPreparing: "Preparing data · {done} of {total}",
  planPreparingHint: "The first list opens when the data is ready. You can leave this page.",
  planFailedSome: "{failed} symbols could not be loaded and read as no data",
  planContinue: "Continue",
  planStart: "Start Day 1",
  planNew: "New plan",
  planReplace: "Start day saves this plan, replaces your current one and opens its first list. Your finished days stay in Recent sessions.",
  planStartError: "Couldn't open the list · Try again",
  planFilters: "Filters",
  planFiltersEmpty: "No filters found · save one in the Screener first",
  planFiltersMax: "Pick one to three filters",
  planListAt: "List time",
  planListSize: "List size",
  planStartDay: "First day",
  planSubmit: "Start day",
  planListAtNeeds: "{filters} needs a list time of {time} or later · before then none of its bars of the day has closed",
  planArmed: "Armed on practice days: {names}",
  planArmedNone: "Nothing armed · no would-fire signals while you practise",
  planDays: "Days",
  planMaxSymbols: "Names a day",
  planMaxSymbolsHint: "The most names you can star and practise in one day",
  planHideDates: "Hide dates",
  dayLoading: "Building the list…",
  dayLoadError: "Couldn't load this day · Try again",
  dayNoPlan: "No practice day selected",
  dayHeader: "List at {listAt} from data through {through} · {scanned} of {size} scanned · {matched} matched, showing {shown}",
    dayNoNames: "No names matched this morning",
  dayStar: "Star {symbol}",
  dayUnstar: "Unstar {symbol}",
  dayRemove: "Remove {symbol} from your names",
  dayStarsFull: "You can star at most 5 names",
  dayStarsFullAt: "Your plan limits a day to {max} {names} · unstar one first",
  dayWatch: "Your names",
  dayWatchEmpty: "Star up to 5 names to keep them in view",
  dayPractise: "Practise {symbol}",
  dayPractiseHint: "Switch names any time · close an open trade first · End day scores the day",
  dayNamesToday: "{used} of {max} {names} practised today",
  dayNamesTitle: "Day names",
  daySwitch: "Switch to {symbol}",
  dayOnNow: "On now",
  dayBehind: "Behind the clock",
  dayHolding: "Open trade",
  daySwitchHint: "A name opens at the day clock, {time}. What it did earlier is on its chart and is not scored.",
  dayStripNone: "Star a name on the list, or pick one from the table, to start practising",
  replayBehind: "{symbol} is behind the day clock, {clock} · catch up to practise it. What happened meanwhile is on the chart and is not scored.",
  replayCatchUp: "Catch up",
  replayCatchUpError: "Couldn't catch up · Try again",
  signalUnseen: "not scored · fired while you were on another name",
  dayEnd: "End day",
  dayEndWarning: "Ending the day shows how every name moved after the list.",
  dayEnded: "Day over",
  dayPeek: "Peek",
  dayPeekNone: "Pick a row to peek at its chart before the open",
  dayPeekDaily: "Daily bars on the same share basis as the list",
  dayPeekToday: "Today so far",
  dayReported: "Reported before the open",
  dayStartError: "Couldn't start the practice · Try again",
  reviewTitle: "How the list moved",
  reviewNote: "Moves are from each name's list price, not from the open",
  reviewSelection: "Your names moved {moves} · list median {median} · ranked {ranks} of {of}",
  reviewNoPicks: "You did not star or trade a name",
  reviewEmpty: "No moves to show for this day",
  backToList: "Back to the list",
  dayAfter: "Next day",
  dayFinished: "You have finished every day of this plan",
  // Practice threads (02r): the pretend account she practises in across days. Every dollar is SIMULATED.
  threadsTitle: "Your practice threads",
  threadsHint: "A thread keeps its pretend balance from day to day, and on days you skip",
  threadsLoading: "Loading your practice threads…",
  threadsLoadError: "Couldn't load your practice threads · Try again",
  threadSimulated: "Simulated",
  threadActive: "Active",
  threadClosedBadge: "Closed",
  threadSwitcher: "Your threads",
  threadBalance: "Balance",
  threadDaysPracticed: "Days practiced",
  threadSkipped: "Skipped",
  threadWinRate: "Win rate",
  threadAdherence: "Adherence",
  threadAdherenceBy: "by day",
  threadToday: "Today",
  threadStartedWith: "Started with {start} · {change} so far",
  threadStartedFlat: "Started with {start} · no change yet",
  threadNoToday: "No practice day open · the next list opens when you resume",
  threadTodayLine: "{pnl} realized so far · {trades}",
  threadBalanceLine: "Thread balance {balance}",
  threadTodayShort: "today {pnl}",
  threadResume: "Resume thread",
  threadResumeHint: "Continues today's list. The balance carries over, also when you skip a day.",
  threadResumeNeedsPlan: "Set up the daily list below to start practising in this thread",
  threadResumeError: "Couldn't open the list · Try again",
  threadJournal: "Open journal",
  threadNewTitle: "New thread",
  threadNewHint: "The risk plan lives here now",
  threadStartingBalance: "Starting balance",
  threadMode: "Mode",
  threadModeDay: "Day trading",
  threadModeSwing: "Swing · later",
  threadSwingReason: "Reason: swing practice arrives in a later phase",
  threadStopOnEntry: "Stop on every entry",
  threadSignalOnly: "Trade only on a signal",
  threadMaxLoss: "Max loss ($)",
  threadMaxTrades: "Max trades",
  threadPlanNote: "Plan note",
  threadSubmit: "Start thread",
  threadSubmitHint: "Starts with a pretend {balance}. You can change the plan later.",
  threadStartError: "Couldn't start the thread · Try again",
  threadOneActive: "One active thread at a time · close {name} in its journal to start another",
  threadNone: "No practice thread yet · start one to get a pretend balance",
  threadClosedTitle: "This thread is closed",
  threadClosedBody: "Its journal and final balance stay here. Start a new thread to keep practising.",
  threadStartNew: "Start a new thread",
  threadNeeded: "Start a practice thread first · it holds your simulated balance and risk plan",
  threadPlanFrom: "The risk plan comes from your thread",
  threadTileOpened: "of {n} days opened",
  threadTileCarried: "balance carried over",
  threadTileTrades: "practice trades",
  threadTileNoTrades: "no wins or losses yet",
  threadTileOfTrades: "{wins} of {trades} trades",
  threadTilePerWin: "per winning trade",
  threadTilePerLoss: "per losing trade",
  threadTileAdherenceBy: "first to latest scored day",
  journalThreadTitle: "Thread journal",
  journalThreadIntro: "Your pretend balance day by day: how it rose and dipped, which days won or lost, and which days you skipped. Skipped days change nothing. The balance just carries to the next day you practise.",
  journalThreadLoading: "Loading your thread…",
  journalThreadLoadError: "Couldn't load this thread · Try again",
  journalThreadNone: "No practice thread selected",
  journalThreadClosed: "This thread is closed · final balance {balance} · its journal stays here",
  journalThreadEmpty: "The balance curve starts after your first practice day ends.",
  journalThreadEmptyLine: "{balance} · 0 days practiced",
  balanceNow: "Balance now",
  curveTitle: "Balance at the end of each day",
  curveHint: "Dollars · red shading = below the starting balance · open circle = skipped day, balance carries",
  curveStart: "Starting balance",
  barsTitle: "Result of each day",
  barsHint: "Dollars gained or lost per day · green = won · red = lost · dashed box = skipped, nothing changed",
  summaryTitle: "Summary so far",
  summaryHint: "Wins and losses count practice trades · today's day is still open",
  weeksTitle: "Weeks",
  weeksHint: "day results, pretend dollars",
  weeksAll: "All weeks",
  weeksNone: "No weeks yet · a week appears after your first practice day",
  legendTitle: "How to read the charts",
  legendWon: "A day you won",
  legendLost: "A day you lost",
  legendSkipped: "A day you skipped: nothing changes",
  improvementTitle: "Improvement",
  improvementIntro: "First week against the latest week (week {n}, {days} so far).",
  improvementTooFew: "Too few days to call a trend yet",
  improvementReason: "Reason: week {n} has {days} so far. A trend needs at least 2 weeks with 3 or more practice days each.",
  improvementReasonOneWeek: "Reason: improvement compares weeks. It waits for at least 2 weeks with practice days.",
  improvementVerdict: "Week {latest} averaged {latestAvg} a practice day; week {first} averaged {firstAvg}.",
  threadPlanTitle: "Thread plan",
  threadEditPlan: "Edit plan",
  threadSavePlan: "Save plan",
  threadPlanApplies: "A change applies from your next session. A session already started keeps its plan.",
  threadPlanSaveError: "Couldn't save the plan · Try again",
  threadClose: "Close thread",
  threadCloseCaption: "Closing keeps this journal and the final balance, and stops new days. A closed thread can't be reopened. Start a new thread to keep practising.",
  threadCloseReason: "Reason: closing ends the practice record only. No real account is touched.",
  threadCloseConfirm: "Close this thread",
  threadCloseKeep: "Keep it open",
  threadCloseError: "Couldn't close the thread · Try again",
} as const;

/** Words that must not appear in Practice copy: there is no order, position, fill or broker in this lane (02o §a5). */
export const PRACTICE_BANNED_TERMS: readonly RegExp[] = [
  /\border(?:s|ed|ing)?\b/i,
  /\bpositions?\b/i,
  /\bfill(?:s|ed)?\b/i,
  /\bbrokers?\b|\bbrokerage\b/i,
  /\bexecut(?:e|es|ed|ing|ion)\b/i,
];

export function containsPracticeBannedTerm(text: string): boolean {
  return containsBannedTerm(text) || PRACTICE_BANNED_TERMS.some((pattern) => pattern.test(text));
}

type PracticeKey = keyof typeof PRACTICE_COPY;
export const practiceText = (key: PracticeKey, values: Record<string, string | number> = {}): string =>
  fill(PRACTICE_COPY[key], Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])));

/** "Practice · replay of Fri 2026-10-23 · nothing here reaches IBKR"; `day` null on the hub, `hidden` while the date is masked. */
export function practiceBandText(day: string | null, hidden = false): string {
  if (hidden) return PRACTICE_COPY.bandHidden;
  return day ? practiceText("band", { day: formatEtDay(day) }) : PRACTICE_COPY.bandHub;
}

/** The top-bar badge during a replay: "Replay · Fri 2026-10-23 · 10:07 AM ET" or "Replay · hidden day · 10:07 AM ET". */
export function replayBadgeText(day: string, playhead: string | null, hidden: boolean): string {
  const time = formatEtTimeZone(playhead);
  return hidden ? practiceText("badgeHidden", { time }) : practiceText("badge", { day: formatEtDay(day), time });
}
