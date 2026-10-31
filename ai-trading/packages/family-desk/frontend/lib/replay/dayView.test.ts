import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm, PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { DailySchema, DayListSchema, OpenNextSchema, UniverseDaysSchema } from "./daily.ts";
import { dayList, endedDayList, plan } from "./dailyFixtures.ts";
import {
  blockLadder,
  canRescan,
  cellText,
  cellTone,
  dayBalanceText,
  dayFinishedLine,
  dayRecordText,
  dayCellText,
  dayCellTone,
  dayColumns,
  dayNumberText,
  dayTitle,
  filtersNote,
  filtersText,
  journalLine,
  listBuiltText,
  listCountsText,
  listHeaderText,
  listWarning,
  moveText,
  nameActionLabel,
  namesTodayText,
  ordinal,
  peekDailyBars,
  peekOffsets,
  planArmedText,
  dayActionLabel,
  blockOpenByDefault,
  dayRouteProblem,
  practiceWindow,
  tradeTotalRow,
  planCard,
  rescanCounts,
  rescanLabel,
  rescanStaleText,
  riskPlanText,
  selectionText,
  sessionResumeHref,
  sourceNote,
  stripRows,
  syntheticDays,
  threadDayNo,
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
  assert.match(listed.detail ?? "", /^Day 6 done · Day 7 next/, "a listed day says the day before it is done (D-051)");
  assert.doesNotMatch(open.detail ?? "", /done/);
  assert.doesNotMatch(planCard({ ...plan, current: { id: 40, day_no: 1, status: "listed" } }).detail ?? "", /done/, "Day 1 has no day before it");
  const ended = planCard({ ...plan, current: { id: 41, day_no: 6, status: "ended" } });
  assert.doesNotMatch(ended.headline, /in progress|list ready/);
  assert.equal(ended.headline, "Day 7 of 20 · next: Tue");
  const first = planCard({ ...plan, days_opened: 0, current: null, next_day_no: 1, next_weekday: "Mon", next_day: "2026-03-02", prep: { state: "done", done: 3, total: 3, failed: 0 } });
  assert.deepEqual([first.headline, first.action], ["Day 1 of 20 · next: Mon", "start"]);
  const preparing = planCard({ ...plan, days_opened: 0, current: null, prep: { state: "running", done: 12, total: 131, failed: 0 } });
  assert.deepEqual([preparing.headline, preparing.action], ["Preparing data · 12 of 131 names", "none"], "D-084: the count has a unit");
  const done = planCard({ ...plan, finished: true, next_day: null, next_weekday: null, next_day_no: null });
  assert.equal(done.headline, "All 20 days done");
});

test("D-047, D-118: a plan after another plan names each day by its place in the thread, with one counter", () => {
  const after = { ...plan, day_offset: 2 };
  assert.equal(threadDayNo(after, 1), 3, "the plan's Day 1 is the thread's third day");
  assert.equal(dayNumberText(plan, 7), "Day 7 of 20", "with no earlier plan the two numbers agree and one is said");
  assert.equal(dayNumberText(after, 1), "Day 3", "one counter: the plan's own count is not said beside it (D-118)");
  assert.equal(dayTitle({ ...dayList, plan: after }, true), "Day 9 · Tue");
  assert.equal(planCard({ ...after, current: { id: 42, day_no: 7, status: "practicing" } }).headline, "Day 9 · in progress");
  assert.equal(planCard({ ...after, current: { id: 42, day_no: 7, status: "listed" } }).headline, "Day 9 · list ready");
  const between = planCard(after);
  assert.equal(between.headline, "Day 9 · next: Tue");
  assert.equal(between.detail?.startsWith("Day 8 done"), true, "the day that ended is the thread's day too");
  const rows = blockLadder({ day_no: 2, of: 5, status: "listed", weekday: "Wed" }, 2);
  assert.deepEqual(rows.map((row) => row.detail), ["Ended · review", "Open now", "Opens after day 4", "Locked", "Locked"]);
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

test("stars toggle, keep order, and never refuse a name (a practice day has no cap)", () => {
  assert.deepEqual(toggledStars([{ symbol: "A" }], "B"), ["A", "B"]);
  assert.deepEqual(toggledStars([{ symbol: "A" }, { symbol: "B" }], "A"), ["B"]);
  const twenty = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}` }));
  assert.equal(toggledStars(twenty, "NEW").length, 21);
  const many = Array.from({ length: 60 }, (_, i) => ({ symbol: `M${i}` }));
  assert.deepEqual(toggledStars(many, "NEW"), [...many.map((star) => star.symbol), "NEW"]);
  assert.equal(toggledStars(many, "M0").length, 59);
});

test("warnings: the server's reason is shown as it is; a list it had no reason for shows the empty state, not a second banner", () => {
  assert.equal(listWarning(dayList), "Only 2 of the 131 scanned symbols met Gap up or Abnormal volume · loosen a filter in the Screener to widen the next days' lists");
  const why = "None of the 17 scanned symbols met Gap up or Abnormal volume · loosen a filter in the Screener to widen the next days' lists";
  assert.equal(listWarning({ warnings: [why] }), why);
  assert.equal(listWarning({ warnings: [] }), null);
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
  assert.equal(selectionText(review), "Your names moved +3.11% · list median +1.40% · ranked 1st of 2");
  const two = { ...review, of: 30, selection: { ...review.selection, picks: [{ symbol: "A", kind: "traded" as const, move_pct: 3.1, rank: 4 }, { symbol: "B", kind: "starred" as const, move_pct: -0.4, rank: 11 }] } };
  assert.equal(selectionText(two), "Your names moved +3.10% and −0.40% · list median +1.40% · ranked 4th and 11th of 30");
  const down = { ...review, selection: { ...review.selection, median_move_pct: -0.4 } };
  assert.equal(selectionText(down), "Your names moved +3.11% · list median −0.40% · ranked 1st of 2", "the median is signed: a losing list reads as one");
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
    { key: "META-1-2026-07-01T14:15:00Z", symbol: "META", side: "Long", shares: "100", entry: "610.83", entryTime: "10:15 AM", exit: "626.48", exitTime: "11:10 AM", pnl: "+$1,565.00", tone: "up" },
  ]);
  const auto = { ...meta, lines: [{ ...meta.lines[0]!, side: "short" as const, exit_source: "auto" as const, pnl_usd: -12.5 }] };
  assert.deepEqual([tradeLineRows(auto)[0]!.side, tradeLineRows(auto)[0]!.exitTime, tradeLineRows(auto)[0]!.pnl, tradeLineRows(auto)[0]!.tone], ["Short", "11:10 AM (auto, window end)", "−$12.50", "down"]);
  assert.deepEqual(tradeLineRows({ lines: [] }), []);
});

test("the review says the day is finished when the plan hid its date, and says nothing otherwise (D-029)", () => {
  assert.equal(dayFinishedLine({ dates_hidden: true }), "Day finished");
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

test("a day the Desk recorded keeps the server's note instead of the line about today's set (02o-b2)", () => {
  const note = "Practice universe · the 118 symbols the Desk scanned that morning, as recorded";
  const recorded = { size: 116, label: note, footnote: `${note} · Gap up scans your Movers list as it is today`, membership: { source: "universe_days" as const, recorded_size: 118, scanned_size: 116, note } };
  assert.equal(universeNote(recorded), recorded.footnote);
  assert.equal(universeNote({ ...recorded, membership: { ...recorded.membership, source: "today" as const } }).startsWith("Universe: today's Desk set"), true);
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

test("hidden Peek bars are named by how many sessions back they are: D-12 up to D-1, the prior close (M4)", () => {
  assert.deepEqual(peekOffsets(3), ["D-3", "D-2", "D-1"]);
  assert.deepEqual(peekOffsets(0), []);
});

// ---- the day's names (02o-b2) ---------------------------------------------------------------------------------

const opened = (symbol: string, id: number, changes: Partial<(typeof dayList)["sessions"][number]> = {}) => ({
  id,
  symbol,
  status: "active" as const,
  revealed_through: "2026-03-10T14:00:00Z",
  behind_clock: false,
  has_open_trade: false,
  ...changes,
});

test("no copy says a day is limited to N names or asks her to unstar one first", () => {
  for (const [key, text] of Object.entries(PRACTICE_COPY)) {
    assert.doesNotMatch(String(text), /limits a day|unstar one first|star at most|names a day/i, key);
  }
});

test("the day strip lists the names she opened, then the starred ones she has not", () => {
  const list = {
    sessions: [opened("SMCI", 12, { has_open_trade: true }), opened("ANET", 13, { behind_clock: true })],
    watch: [{ symbol: "NVDA", starred_clock: "2026-03-10T12:30:00Z" }, { symbol: "SMCI", starred_clock: "2026-03-10T12:30:00Z" }],
  };
  assert.deepEqual(stripRows(list), [
    { symbol: "SMCI", sessionId: 12, starred: true, behind: false, holding: true },
    { symbol: "ANET", sessionId: 13, starred: false, behind: true, holding: false },
    { symbol: "NVDA", sessionId: null, starred: true, behind: false, holding: false },
  ]);
  assert.deepEqual(stripRows({ sessions: [], watch: [] }), []);
  // A name whose playhead is earlier than the one she is on is behind the clock, though the list read says it was not.
  const lagging = { sessions: [opened("SMCI", 12, { revealed_through: "2026-03-10T14:00:00Z" }), opened("ANET", 13)], watch: [] };
  const behindOf = (rows: ReturnType<typeof stripRows>) => rows.map((row) => [row.symbol, row.behind]);
  assert.deepEqual(behindOf(stripRows(lagging, { symbol: "ANET", playhead: "2026-03-10T14:05:00Z" })), [["SMCI", true], ["ANET", false]]);
  assert.deepEqual(behindOf(stripRows(lagging, { symbol: "SMCI", playhead: "2026-03-10T14:00:00Z" })), [["SMCI", false], ["ANET", false]]);
});

test("the names line counts the names opened, with no cap to count against", () => {
  const two = { sessions: [opened("SMCI", 12), opened("ANET", 13)] };
  assert.equal(namesTodayText(two), "2 names practiced today");
  assert.equal(namesTodayText({ sessions: [opened("SMCI", 12)] }), "1 name practiced today");
  for (const text of [namesTodayText(two), practiceText("replayBehind", { symbol: "ANET", clock: "10:30 AM ET" })]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
  }
});

// ---- the recorded universe (02o-b2) -----------------------------------------------------------------------------

test("a list says where its names came from, and an older list without that still parses", () => {
  const recorded = { source: "universe_days", recorded_size: 118, scanned_size: 116, note: "Practice universe · the 118 symbols the Desk scanned that morning, as recorded · 2 of them were not in your plan's prepared set and are left out" };
  const withMembership = DayListSchema.parse({ ...dayList, universe: { ...dayList.universe, membership: recorded } });
  assert.equal(withMembership.universe.membership?.source, "universe_days");
  assert.equal(DayListSchema.parse(dayList).universe.membership ?? null, null);
  assert.equal(DayListSchema.safeParse({ ...dayList, universe: { ...dayList.universe, membership: { ...recorded, source: "memory" } } }).success, false);
  assert.equal(containsPracticeBannedTerm(recorded.note), false);
});

test("the recorded-universe answer parses with and without a day, and a bad day is refused", () => {
  const base = { coverage: { first_day: null, last_day: null, days: 0 }, first_day_default: null, first_day_note: "The Desk has not recorded a morning's universe yet · the default start is three months back", day: null };
  assert.equal(UniverseDaysSchema.parse(base).first_day_default, null);
  const ready = { ...base, coverage: { first_day: "2026-09-28", last_day: "2026-10-23", days: 20 }, first_day_default: "2026-09-28", day: { day: "2026-09-28", recorded: true, size: 2, symbols: ["FLAT", "GAPPER"], note: "x" } };
  assert.equal(UniverseDaysSchema.parse(ready).day?.symbols.length, 2);
  assert.equal(UniverseDaysSchema.safeParse({ ...ready, first_day_default: "soon" }).success, false);
});

// ---- re-scan at the day clock (02o-b2) --------------------------------------------------------------------------

const scan = {
  seq: 2,
  as_of: "2026-03-10T14:00:00Z",
  data_through: "2026-03-10T13:45:00Z",
  universe: { ...dayList.universe, shown: 2, matches_total: 3 },
  columns: dayList.columns,
  candidates: dayList.candidates.map((candidate, index) => ({ ...candidate, new_since_list: index === 1 })),
  new_count: 1,
  created_at: "2026-03-10T14:00:04Z",
};
const practising = { ...dayList, status: "practicing" as const, clock: "2026-03-10T13:30:00Z", rescan: scan };

test("a list with a re-scan parses, and the scan must say which names are new since the list", () => {
  const parsed = DayListSchema.parse(practising);
  assert.deepEqual(parsed.rescan?.candidates.map((candidate) => candidate.new_since_list), [false, true]);
  const bare: Record<string, unknown> = { ...scan.candidates[0]! };
  delete bare.new_since_list;
  assert.equal(DayListSchema.safeParse({ ...practising, rescan: { ...scan, candidates: [bare] } }).success, false);
  assert.equal(DayListSchema.safeParse({ ...practising, rescan: undefined }).success, false); // null is the empty answer, not a missing key
});

test("a re-scan is open once the day clock has started and is closed after the day ends", () => {
  assert.equal(canRescan(dayList), false); // listed: no clock yet
  assert.equal(canRescan(practising), true);
  assert.equal(canRescan({ ...practising, clock: "2026-03-10T12:00:00Z" }), false); // before the list time
  assert.equal(canRescan(endedDayList), false);
});

test("the scan says the clock it ran at, where its data stops, and what is new, without naming the day", () => {
  const label = rescanLabel(scan);
  assert.match(label, /^Scan 2 · run at 10:00 AM ET · data through 9:45 AM$/);
  assert.equal(rescanCounts(scan), "2 of 3 matched · 1 new since your list");
  for (const text of [label, rescanCounts(scan)]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
    assert.doesNotMatch(text, /2026|Mar/);
  }
});

test("a scan older than the day clock says so, and a current one does not", () => {
  assert.equal(rescanStaleText({ clock: "2026-03-10T14:00:00Z", rescan: scan }), null);
  assert.equal(rescanStaleText({ clock: "2026-03-10T14:00:00Z", rescan: null }), null);
  const stale = rescanStaleText({ clock: "2026-03-10T14:30:00Z", rescan: scan });
  assert.equal(stale, "The day clock is now 10:30 AM ET · this scan is older. Re-scan to update it.");
  assert.equal(containsPracticeBannedTerm(stale ?? ""), false);
});

// D-078: "Resume" was the label of a day never started and of opening the next day after an ended one (a mutation).
test("a day thread's one action says what it does (D-078)", () => {
  const listed = { day_list_id: 41, day: "2026-03-10", weekday: "Tue", day_no: 7, status: "listed", trades: 0, pnl_usd: 0 } as const;
  assert.equal(dayActionLabel(listed, plan), "Open Day 7", "a listed day that was never started opens");
  assert.equal(dayActionLabel({ ...listed, status: "practicing" }, plan), "Resume Day 7", "only a day in progress resumes");
  assert.equal(dayActionLabel({ ...listed, day_no: 1 }, { ...plan, day_offset: 1 }), "Open Day 2", "a plan that replaced another counts on from the days the thread already ended");
  // No open day: opening the next one starts it. The number is the thread's own (D-047).
  assert.equal(dayActionLabel(null, { ...plan, current: { id: 41, day_no: 6, status: "ended" } }), "Start Day 7");
  assert.equal(dayActionLabel(null, { ...plan, day_offset: 3, current: { id: 41, day_no: 6, status: "ended" } }), "Start Day 10");
  assert.equal(dayActionLabel(null, { ...plan, days_opened: 0, current: null, next_day_no: 1 }), "Start Day 1");
  assert.equal(dayActionLabel(null, { ...plan, days_opened: 0, current: null, prep: { state: "running", done: 1, total: 9, failed: 0 } }), null, "while the data prepares there is nothing to press");
  assert.equal(dayActionLabel(null, null), null);
});

// D-095 once said "Star up to N names" next to "Starred 0 of N". There is no N now: the header counts stars and the rail asks for none.
test("the starred header and the empty rail name no cap", () => {
  assert.equal(practiceText("dayStarred", { n: 4 }), "Starred 4");
  assert.equal(PRACTICE_COPY.dayWatchEmpty, "Star names to keep them in view");
});

// D-097: on a 20-day block the day list pushed the starred names below the fold.
test("a long block's days start collapsed, a short block's open (D-097)", () => {
  assert.equal(blockOpenByDefault(5), true);
  assert.equal(blockOpenByDefault(10), true);
  assert.equal(blockOpenByDefault(20), false);
  assert.equal(blockOpenByDefault(30), false);
});

// D-117: a bad id said "No practice day selected", the same as no id at all.
test("a day route with an id that is not a number is not found, and one with no id is not chosen (D-117)", () => {
  assert.equal(dayRouteProblem(null), "none");
  assert.equal(dayRouteProblem("abc"), "missing");
  assert.equal(dayRouteProblem("12"), null, "a good id has no problem");
});

// D-144: the Thread plan said Window 09:30 to 11:30, the list was built at 8:30 and Re-list said the window then starts at 10:00.
test("the practice window starts at the later of the plan's window and the list time, so a re-list moves it (D-144)", () => {
  const window = { from: "09:30", to: "11:30" };
  assert.deepEqual(practiceWindow({ list_at: "2026-03-10T13:30:00Z", plan: { spec: { setup: { window } } } }), { from: "09:30", to: "11:30" }, "built at 9:30 ET: the plan's own start");
  assert.deepEqual(practiceWindow({ list_at: "2026-03-10T12:30:00Z", plan: { spec: { setup: { window } } } }), { from: "09:30", to: "11:30" }, "built at 8:30 ET, before the window");
  assert.deepEqual(practiceWindow({ list_at: "2026-03-10T15:00:00Z", plan: { spec: { setup: { window } } } }), { from: "11:00", to: "11:30" }, "re-listed at 11:00 ET: the window starts then");
});

// D-142: the total of the day's trades, and one precision for the selection's moves (the table shows two decimals).
test("the trade table ends on a total row, and the selection quotes the table's precision (D-142)", () => {
  const total = tradeTotalRow({ trades: 2, pnl_usd: 12.5 });
  assert.deepEqual([total.key, total.symbol, total.pnl], ["total", "Total", "+$12.50"]);
  assert.equal(selectionText(endedDayList.review!), "Your names moved +3.11% · list median +1.40% · ranked 1st of 2");
});

test("Resume belongs to the thread's day, never to one name: a name's button says Practice or Switch, and a day session resumes through its day", () => {
  assert.deepEqual([nameActionLabel(false), nameActionLabel(true)], ["Practice", "Switch"]);
  assert.equal(sessionResumeHref({ id: 9, day_list_id: 42 }), "/practice/day?id=42", "a day-list session resumes the whole day, on its shared clock");
  assert.equal(sessionResumeHref({ id: 9, day_list_id: null }), "/practice/replay?id=9", "a standalone session has no day to resume through");
});
