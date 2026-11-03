import { formatEtClock, formatEtTimeZone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { Screen } from "./screen.ts";

// The status bar's own line on a Practice route (D-043): where the prices come from, what the screen waits for, and the
// clock it stands at. The shell shows it in place of its live-quotes line, which does not apply to past days.

export type PracticeStatusLine = { left: readonly string[]; right: readonly string[] };

/** The Screen: "Prices: Alpaca SIP · up to the thread clock | The scan runs at the thread clock ... Scanned 9:32 AM ET | Would-fire signals only". The scan's clock is the one time; a new Screen has none until its first scan. */
export function screenStatusLine(screen: Pick<Screen, "rescan">): PracticeStatusLine {
  return {
    left: [PRACTICE_COPY.statusPricesPast, PRACTICE_COPY.statusScanAtClock],
    right: [screen.rescan === null ? PRACTICE_COPY.screenStatusNotScanned : practiceText("statusScanned", { time: formatEtTimeZone(screen.rescan.as_of) }), PRACTICE_COPY.statusSignals],
  };
}

/** The thread journal: "... Journal is read live, by ET date ... Balance as of 2026-10-23". */
export function journalStatusLine(daily: ReadonlyArray<{ day: string }>): PracticeStatusLine {
  const last = daily.at(-1);
  return {
    left: [PRACTICE_COPY.statusPricesPast, PRACTICE_COPY.statusJournalLive],
    right: [last ? practiceText("statusBalanceAsOf", { day: last.day }) : PRACTICE_COPY.statusBalanceStart, PRACTICE_COPY.statusSignals],
  };
}

/** The replay workspace: "Prices: Alpaca SIP · replay | Consolidated tape ... Replay clock 10:07:00 AM ET | Would-fire signals only". The feed is the lane's own. */
export function replayStatusLine(feed: "sip" | "iex", playhead: string): PracticeStatusLine {
  return {
    left: [feed === "iex" ? PRACTICE_COPY.statusPricesReplayIex : PRACTICE_COPY.statusPricesReplay, feed === "iex" ? PRACTICE_COPY.feedIex : PRACTICE_COPY.feedSip],
    right: [practiceText("statusReplayClock", { time: formatEtClock(playhead) }), PRACTICE_COPY.statusSignals],
  };
}
