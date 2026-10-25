import { formatEtClock, formatEtTimeZone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";

// The status bar's own line on a Practice route (D-043): where the prices come from, what the screen waits for, and the
// clock it stands at. The shell shows it in place of its live-quotes line, which does not apply to past days.

export type PracticeStatusLine = { left: readonly string[]; right: readonly string[] };

/** The day list: "Prices: Alpaca SIP · past days | Day lists built before the open ... List built 8:30 AM ET | Would-fire signals only". */
export function dayStatusLine(list: { list_at: string }): PracticeStatusLine {
  return {
    left: [PRACTICE_COPY.statusPricesPast, PRACTICE_COPY.statusDayLists],
    right: [practiceText("statusListBuilt", { listAt: formatEtTimeZone(list.list_at) }), PRACTICE_COPY.statusSignals],
  };
}

/** The thread journal: "... Journal updates when a day ends ... Balance as of day 8". */
export function journalStatusLine(daily: ReadonlyArray<{ n: number }>): PracticeStatusLine {
  const last = daily.at(-1);
  return {
    left: [PRACTICE_COPY.statusPricesPast, PRACTICE_COPY.statusJournalUpdates],
    right: [last ? practiceText("statusBalanceAsOf", { day: last.n }) : PRACTICE_COPY.statusBalanceStart, PRACTICE_COPY.statusSignals],
  };
}

/** The replay workspace: "Prices: Alpaca SIP · replay | Consolidated tape ... Replay clock 10:07:00 AM ET | Would-fire signals only". The feed is the session's own. */
export function replayStatusLine(feed: "sip" | "iex", playhead: string): PracticeStatusLine {
  return {
    left: [feed === "sip" ? PRACTICE_COPY.statusPricesReplay : PRACTICE_COPY.statusPricesReplayIex, feed === "sip" ? PRACTICE_COPY.feedSip : PRACTICE_COPY.feedIex],
    right: [practiceText("statusReplayClock", { time: formatEtClock(playhead) }), PRACTICE_COPY.statusSignals],
  };
}
