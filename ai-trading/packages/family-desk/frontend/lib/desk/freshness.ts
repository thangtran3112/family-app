import type { Stamp } from "../api/schemas.ts";
import { formatAgo, formatEtClock, formatEtTime, formatEtTimeZone, formatEtWeekdayTime } from "./format.ts";

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
  futuresNotConnected: "Waiting for IBKR · not connected yet",
  futuresReadOnly: "Futures · read only",
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
  /(?<![:\d])[1-5]\d{2}(?![:\d])/, // HTTP status codes (3-digit numbers); times such as 10:41:12 do not match
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

export function freshnessState({ stamp, session, connection = "ok" }: FreshnessInput): FreshnessState {
  if (connection === "reconnecting") return "reconnecting";
  if (!stamp) return "updating";
  if (stamp.freshness === "unavailable" || stamp.quality === "unavailable") return "unavailable";
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
  if (view.state === "closed") return `Quotes: ${source} · Market closed`;
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

/** D11 market-data rows: "Quotes: Alpaca · Delayed 15 min". */
export function marketDataLine(kind: "Quotes" | "Scans", stamp: Pick<Stamp, "source" | "quality"> | null): string {
  if (!stamp) return `${kind}: Unavailable`;
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
