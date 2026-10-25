import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm, PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { DailySchema, DayListSchema, OpenNextSchema } from "./daily.ts";
import { dayList, endedDayList, plan } from "./dailyFixtures.ts";
import {
  blockLadder,
  cellText,
  cellTone,
  dayBalanceText,
  dayFinishedLine,
  dayRecordText,
  dayCellText,
  dayCellTone,
  dayColumns,
  dayTitle,
  filtersNote,
  filtersText,
  journalLine,
  listBuiltText,
  listCountsText,
  listHeaderText,
  listWarning,
  moveText,
  noMatchText,
  ordinal,
  peekDailyBars,
  planArmedText,
  planCard,
  riskPlanText,
  selectionText,
  sourceNote,
  syntheticDays,
  toggledStars,
  tradeLineRows,
  universeNote,
} from "./dayView.ts";

test("the daily payloads parse, and the contract's required fields are required", () => {
  assert.equal(DayListSchema.parse(dayList).candidates.length, 2);
  assert.equal(DayListSchema.parse(endedDayList).review?.rows[0]?.picked, "traded");
  assert.equal(DailySchema.parse({ plan, thread: null }).plan?.next_weekday, "Tue");
  assert.equal(DailySchema.parse({ plan: null, thread: null }).plan, null);
  assert.equal(OpenNextSchema.parse({ plan, day_list_id: null }).day_list_id, null);
  assert.equal(DayListSchema.safeParse({ ...dayList, universe: undefined }).success, false);
  assert.equal(DayListSchema.safeParse({ ...dayList, status: "open" }).success, false);
});

test("the day title names the weekday and shows the date only when dates are on", () => {
  assert.equal(dayTitle(dayList, true), "Day 7 of 20 · Tue");
  assert.equal(dayTitle(dayList, false), "Day 7 of 20 · Tue 2026-03-10");
});

test("the list header says when the list was built and from which data", () => {
  assert.equal(
    listHeaderText(dayList),
    "List at 8:30 AM ET from data through 8:15 AM · 118 of 131 scanned · 34 matched, showing 2",
  );
});

test("the hub card reads Day N of M, next weekday, Continue; preparing and finished have their own lines", () => {
  assert.deepEqual(planCard(null), { headline: "No daily plan yet · set one up to start Day 1", detail: null, action: "new" });
  const next = planCard(plan);
  assert.equal(next.headline, "Day 7 of 20 · next: Tue");
  assert.equal(next.action, "continue");
  assert.equal(next.detail, "Day 6 done · 2 symbols could not be loaded and read as no data");
  assert.equal(planCard({ ...plan, prep: { ...plan.prep, failed: 0 } }).detail, "Day 6 done", "an ended day reads done, and Continue opens the next");
  const shown = planCard({ ...plan, spec: { ...plan.spec, hideDates: "no" } });
  assert.equal(shown.headline, "Day 7 of 20 · next: Tue 2026-03-10");
  const open = planCard({ ...plan, current: { id: 42, day_no: 7, status: "practicing" } });
  assert.deepEqual([open.headline, open.action], ["Day 7 of 20 · in progress", "continue"]);
  // D-035: a day that is only listed is not "in progress", and an ended day is never shown as open.
  const listed = planCard({ ...plan, current: { id: 42, day_no: 7, status: "listed" } });
  assert.deepEqual([listed.headline, listed.action], ["Day 7 of 20 · list ready", "continue"]);
  const ended = planCard({ ...plan, current: { id: 41, day_no: 6, status: "ended" } });
  assert.doesNotMatch(ended.headline, /in progress|list ready/);
  assert.equal(ended.headline, "Day 7 of 20 · next: Tue");
  const first = planCard({ ...plan, days_opened: 0, current: null, next_day_no: 1, next_weekday: "Mon", next_day: "2026-03-02", prep: { state: "done", done: 3, total: 3, failed: 0 } });
  assert.deepEqual([first.headline, first.action], ["Day 1 of 20 · next: Mon", "start"]);
  const preparing = planCard({ ...plan, days_opened: 0, current: null, prep: { state: "running", done: 12, total: 131, failed: 0 } });
  assert.deepEqual([preparing.headline, preparing.action], ["Preparing data · 12 of 131", "none"]);
  const done = planCard({ ...plan, finished: true, next_day: null, next_weekday: null, next_day_no: null });
  assert.equal(done.headline, "All 20 days done");
});

test("cells use the column's format and never print null; the since column is a time", () => {
  const [price, change, , , volume, rvol, since] = dayList.columns;
  const smci = dayList.candidates[0]!;
  const anet = dayList.candidates[1]!;
  assert.equal(cellText(price!, smci), "41.12");
  assert.equal(cellText(change!, smci), "+8.50%");
  assert.equal(cellText(volume!, smci), "1.8M");
  assert.equal(cellText(rvol!, anet), "—");
  assert.equal(cellText(since!, smci), "8:30 AM");
  assert.equal(cellText({ key: "volume", format: "mystery" }, smci), "1,820,000");
  assert.equal(cellTone(change!, smci), "up");
  assert.equal(cellTone(price!, smci), null);
  assert.equal(filtersText(smci), "Gap up · Abnormal volume");
});

test("stars toggle, keep order, and refuse a sixth name", () => {
  assert.deepEqual(toggledStars([{ symbol: "A" }], "B"), ["A", "B"]);
  assert.deepEqual(toggledStars([{ symbol: "A" }, { symbol: "B" }], "A"), ["B"]);
  assert.equal(toggledStars(["A", "B", "C", "D", "E"].map((symbol) => ({ symbol })), "F"), null);
});

test("warnings: the server's reason is shown as it is; a list it had no reason for shows the empty state, not a second banner", () => {
  assert.equal(listWarning(dayList), "Only 2 of the 131 scanned symbols met Gap up and Abnormal volume · loosen a filter in the Screener to widen the next days' lists");
  const why = "None of the 17 scanned symbols met Gap up and Abnormal volume · loosen a filter in the Screener to widen the next days' lists";
  assert.equal(listWarning({ warnings: [why] }), why);
  assert.equal(listWarning({ warnings: [] }), null);
  assert.equal(noMatchText({ universe: { ...dayList.universe, matches_total: 0 } }), "0 of 131 matched");
  assert.equal(PRACTICE_COPY.dayNoNames, "No name passed your filters on this day · widen a filter, or end the day to open the next");
  assert.equal(why.includes("Only 0"), false);
});

test("the hub card says what is armed on the practice days: the picked filters by name, other strategies by count", () => {
  const armed = (refs: Array<{ source: "filter" | "alert_strategy"; id: number }>) =>
    ({ ...plan, spec: { ...plan.spec, setup: { ...plan.spec.setup, armed: refs } } });
  assert.equal(planArmedText(plan), "Nothing armed · no would-fire signals while you practice");
  assert.equal(planArmedText(armed([{ source: "filter", id: 9 }, { source: "filter", id: 4 }])), "Armed on practice days: Abnormal volume · Gap up");
  assert.equal(planArmedText(armed([{ source: "filter", id: 4 }, { source: "alert_strategy", id: 1 }, { source: "alert_strategy", id: 2 }])), "Armed on practice days: Gap up · 2 alert strategies");
  assert.equal(planArmedText(armed([{ source: "filter", id: 77 }])), "Armed on practice days: A filter");
});

test("the review reads the picks' moves, the list median and their ranks", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(23), "23rd");
  const review = endedDayList.review!;
  assert.equal(selectionText(review), "Your names moved +3.1% · list median +1.4% · ranked 1st of 2");
  const two = { ...review, of: 30, selection: { ...review.selection, picks: [{ symbol: "A", kind: "traded" as const, move_pct: 3.1, rank: 4 }, { symbol: "B", kind: "starred" as const, move_pct: -0.4, rank: 11 }] } };
  assert.equal(selectionText(two), "Your names moved +3.1% and −0.4% · list median +1.4% · ranked 4th and 11th of 30");
  const down = { ...review, selection: { ...review.selection, median_move_pct: -0.4 } };
  assert.equal(selectionText(down), "Your names moved +3.1% · list median −0.4% · ranked 1st of 2", "the median is signed: a losing list reads as one");
  assert.equal(selectionText({ ...review, selection: { ...review.selection, picks: [] } }), null);
  assert.equal(moveText(null), "—");
  assert.equal(moveText(-0.31), "−0.31%");
  assert.equal(journalLine(endedDayList.journal!), "1 practice trade · +$63.00");
  assert.equal(journalLine({ trades: 0, pnl_usd: 0 }), "0 practice trades · $0.00");
});

// The recorded day (D-032, D-034): META long 100 shares, 610.83 to 626.48, +$1,565.00 on a $50,000.00 balance.
const meta = {
  ...endedDayList.journal!,
  pnl_usd: 1565,
  lines: [
    { no: 1, symbol: "META", side: "long" as const, entry_at: "2026-07-01T14:15:00Z", entry_price: 610.83, exit_at: "2026-07-01T15:10:00Z", exit_price: 626.48, shares: 100, pnl_usd: 1565, r: null, stop_price: null, on_signal: false, exit_source: "her" as const },
  ],
  balance_before: 50000,
  balance_after: 51565,
};

test("the review's day block shows each trade's prices, times and P/L to the cent, with the record and the balance", () => {
  assert.equal(journalLine(meta), "1 practice trade · +$1,565.00", "thousands separator and cents, like the replay header");
  assert.equal(dayRecordText(meta), "1 win · 0 losses");
  assert.equal(dayRecordText({ wins: 2, losses: 1, scratches: 1 }), "2 wins · 1 loss · 1 scratch");
  assert.equal(dayBalanceText(meta), "Balance $50,000.00 → $51,565.00");
  assert.equal(dayBalanceText({ balance_before: null, balance_after: null }), null);
  assert.deepEqual(tradeLineRows(meta), [
    { key: "META-1-2026-07-01T14:15:00Z", symbol: "META", side: "Long", shares: "100", entry: "610.83 · 10:15 AM", exit: "626.48 · 11:10 AM", pnl: "+$1,565.00", tone: "up" },
  ]);
  const auto = { ...meta, lines: [{ ...meta.lines[0]!, side: "short" as const, exit_source: "auto" as const, pnl_usd: -12.5 }] };
  assert.deepEqual([tradeLineRows(auto)[0]!.side, tradeLineRows(auto)[0]!.exit, tradeLineRows(auto)[0]!.pnl, tradeLineRows(auto)[0]!.tone], ["Short", "626.48 · 11:10 AM (auto, window end)", "−$12.50", "down"]);
  assert.deepEqual(tradeLineRows({ lines: [] }), []);
});

test("the review says the day is finished when the plan hid its date, and says nothing otherwise (D-029)", () => {
  assert.equal(dayFinishedLine({ dates_hidden: true }), "Day finished · date shown below");
  assert.equal(dayFinishedLine({ dates_hidden: false }), null);
  assert.equal(PRACTICE_COPY.reviewRankNote, "Ranked by move from list price to window end, biggest gain first");
});

test("the strings the day screens build contain no banned term", () => {
  const built = [
    planCard(plan).headline,
    planCard(null).headline,
    planArmedText(plan),
    practiceText("planListAtNeeds", { filters: "Abnormal volume", time: "10:00 AM" }),
    listHeaderText(dayList),
    listCountsText(dayList),
    listBuiltText(dayList),
    universeNote(dayList.universe),
    sourceNote(dayList),
    filtersNote(2),
    PRACTICE_COPY.dayNoNames,
    riskPlanText({ stopNoteOnEntry: "yes", tradeOnlyOnSignal: "yes", maxLossUsd: 600, maxTrades: 3 }),
    dayTitle(dayList, true),
    selectionText(endedDayList.review!)!,
    journalLine(endedDayList.journal!),
    dayRecordText(meta),
    dayBalanceText(meta)!,
    PRACTICE_COPY.reviewRankNote,
    PRACTICE_COPY.reviewDayFinished,
    PRACTICE_COPY.reviewDayHint,
    PRACTICE_COPY.reviewDayNone,
    ...tradeLineRows(meta).flatMap((row) => [row.entry, row.exit, row.pnl]),
    ...dayList.warnings,
    dayList.universe.footnote,
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});

test("with dates hidden the Peek chart gets a stand-in timeline, never the real dates", () => {
  const bars = [
    { t: "2026-03-06", o: 1, h: 2, l: 1, c: 2, v: 10 },
    { t: "2026-03-09", o: 2, h: 3, l: 2, c: 3, v: 12 },
  ];
  assert.deepEqual(peekDailyBars(bars, false), bars);
  const hidden = peekDailyBars(bars, true);
  assert.deepEqual(hidden.map((bar) => bar.t), ["2001-01-01", "2001-01-02"]);
  assert.deepEqual(hidden.map((bar) => bar.c), [2, 3]);
  assert.equal(syntheticDays(6).at(-1), "2001-01-08"); // weekends are skipped
  assert.equal(JSON.stringify(hidden).includes("2026"), false);
});

test("the counts and the built line are two lines, as P7 has them", () => {
  assert.equal(listCountsText(dayList), "118 of 131 scanned · 34 matched · showing 2");
  assert.equal(listBuiltText(dayList), "List built at 8:30 AM ET from data through 8:15 AM");
  assert.equal(filtersNote(2), "Chosen at setup · a name that passes either one is listed");
  assert.equal(filtersNote(1), "Chosen at setup");
  assert.equal(sourceNote(dayList), "Source: Alpaca SIP bars up to 8:15 AM ET · nothing after the list time is shown");
});

test("the universe note states the Desk set and its size, then what else the server said", () => {
  const universe = { size: 131, label: "Practice universe · 131 symbols the Desk has scanned", footnote: "Practice universe · 131 symbols the Desk has scanned" };
  assert.equal(universeNote(universe), "Universe: today's Desk set, up to 250 names by today's dollar volume (131 names here). It can differ from the names that traded on that day.");
  const more = { ...universe, footnote: `${universe.label} · Gap up scans your Movers list as it is today · capped at 250 by dollar volume` };
  assert.equal(universeNote(more).endsWith("Gap up scans your Movers list as it is today · capped at 250 by dollar volume."), true);
});

test("the risk plan reads as one sentence; no limits says so", () => {
  assert.equal(riskPlanText({ stopNoteOnEntry: "yes", tradeOnlyOnSignal: "yes", maxLossUsd: 600, maxTrades: 3 }), "Risk plan comes from the thread: stop on every entry, trade only on a signal, max loss $600, up to 3 trades a day.");
  assert.equal(riskPlanText({ stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" }), "Risk plan comes from the thread: no limits set");
  assert.equal(riskPlanText({ stopNoteOnEntry: "no", tradeOnlyOnSignal: "no", maxTrades: 1 }), "Risk plan comes from the thread: up to 1 trade a day.");
});

test("the block ladder: earlier days ended, this one open, the next waits for it, the rest are locked", () => {
  const rows = blockLadder({ day_no: 2, of: 5, status: "listed", weekday: "Wed" });
  assert.deepEqual(rows.map((row) => row.state), ["ended", "open", "opens_after", "locked", "locked"]);
  assert.deepEqual(rows.map((row) => row.detail), ["Ended · review", "Open now", "Opens after day 2", "Locked", "Locked"]);
  assert.equal(rows[1]!.weekday, "Wed");
  assert.equal(rows[0]!.weekday, null);
  assert.deepEqual(blockLadder({ day_no: 2, of: 5, status: "ended", weekday: "Wed" }).map((row) => row.state), ["ended", "ended", "opens_after", "locked", "locked"]);
});

test("D-018: a list built before the open fills Prev RVOL and Prev change % from the server's own previous-session columns", () => {
  const columns = dayColumns(dayList);
  assert.deepEqual(columns.map((column) => column.label), ["List price", "vs prev close %", "Prev close", "Prev RVOL", "Prev change %", "Earnings", "Prev volume", "Since"]);
  const smci = dayList.candidates[0]!;
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  assert.equal(dayCellText(byKey.prev_close!, smci), "37.90");
  assert.equal(dayCellText(byKey.prev_rvol!, smci), "1.10×");
  assert.equal(dayCellText(byKey.prev_change_pct!, smci), "+1.20%");
  assert.equal(dayCellTone(byKey.prev_change_pct!, smci), "up");
  assert.equal(dayCellText(byKey.prev_rvol!, dayList.candidates[1]!), "—");
  assert.equal(byKey.prev_rvol!.missing, false);
  assert.equal(dayCellText(byKey.earnings!, smci), "Reported before the open");
  assert.equal(dayCellText(byKey.earnings!, dayList.candidates[1]!), "—");
  assert.equal(dayCellText(byKey.matched_since!, smci), "8:30 AM");
});

test("D-018: a list built after the open has no previous-session RVOL or change, so those columns read a dash, never the live value", () => {
  const live = {
    ...dayList,
    universe: { ...dayList.universe, prev_basis: false },
    columns: [
      { key: "list_price", label: "List price", format: "price" },
      { key: "list_change_pct", label: "vs prev close %", format: "pct_signed" },
      { key: "change_pct", label: "Change %", format: "pct_signed" },
      { key: "rvol_10d", label: "RVOL", format: "ratio" },
      { key: "atr_pct_14", label: "ATR %", format: "pct" },
      { key: "rsi_14", label: "RSI", format: "number" },
      { key: "matched_since", label: "Since", format: "time" },
    ],
  };
  const columns = dayColumns(live);
  assert.deepEqual(columns.map((column) => column.label), ["List price", "vs prev close %", "Prev close", "Prev RVOL", "Prev change %", "ATR %", "RSI", "Earnings", "Change %", "RVOL", "Since"]);
  const smci = { ...live.candidates[0]!, metrics: { ...live.candidates[0]!.metrics, rvol_10d: 2.5 } };
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  assert.equal(dayCellText(byKey.prev_close!, smci), "37.90");
  assert.equal(dayCellText(byKey.prev_rvol!, smci), "—");
  assert.equal(dayCellText(byKey.prev_change_pct!, smci), "—");
  assert.equal(byKey.prev_rvol!.missing, true);
  assert.equal(dayCellText(byKey.rvol_10d!, smci), "2.50×");
});
