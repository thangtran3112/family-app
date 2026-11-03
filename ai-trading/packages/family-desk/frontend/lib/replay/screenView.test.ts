import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm, PRACTICE_COPY } from "../desk/freshness.ts";
import { ScreenSchema, UniverseDaysSchema, type Candidate } from "./screen.ts";
import { emptyScreen, plan, screen } from "./screenFixtures.ts";
import {
  beforeOpen,
  canRescan,
  filtersNote,
  filtersText,
  followState,
  heldFirst,
  heldOverCount,
  isStarred,
  laneLine,
  liveState,
  minuteOfClock,
  neverScanned,
  rescanCounts,
  rescanCurrent,
  rescanLabel,
  rescanPercent,
  rescanProgressText,
  rescanRefusedText,
  rescanRunning,
  rescanStaleText,
  riskPlanText,
  scanBuiltText,
  screenCellText,
  screenCellTitle,
  screenCellTone,
  screenColumns,
  screenCountsText,
  screenTitle,
  screenWarnings,
  sourceNote,
  toggledStars,
  universeNote,
} from "./screenView.ts";

const [smci, anet] = screen.candidates as [Candidate, Candidate];

test("the Screen payloads parse, and the contract's required fields are required", () => {
  assert.equal(ScreenSchema.parse(screen).candidates.length, 2);
  assert.equal(ScreenSchema.parse(screen).candidates[0]?.live ?? null, null, "a snapshot read has no live block");
  const withLive = { ...screen, candidates: [{ ...smci, live: { at: "2026-03-10T14:15:00Z", price: 44.5, change_pct: 17.4, today: true, metrics: { last: 44.5, rvol_10d: null } } }] };
  assert.equal(ScreenSchema.parse(withLive).candidates[0]?.live?.price, 44.5);
  assert.equal(ScreenSchema.safeParse({ ...withLive, candidates: [{ ...withLive.candidates[0]!, live: { at: "x", price: 1, change_pct: 1, today: true, metrics: {} } }] }).success, false, "the live block's time is a timestamp");
  assert.equal(ScreenSchema.parse(emptyScreen).rescan, null, "a new Screen has no scan");
  assert.equal(ScreenSchema.safeParse({ ...screen, universe: undefined }).success, false);
  assert.equal(ScreenSchema.safeParse({ ...screen, clock: null }).success, false, "a Screen is always read at a thread time");
  const bare: Record<string, unknown> = { ...screen };
  delete bare.lanes;
  assert.equal(ScreenSchema.safeParse(bare).success, false, "the names she opened are part of the Screen");
});

test("the title names the ET date of T as a label, and nothing numbers a day", () => {
  assert.equal(screenTitle(screen), "Screen · Tue 2026-03-10");
  assert.equal(screenTitle({ day: "2026-03-14" }), "Screen · Sat 2026-03-14", "a weekend clock is an ordinary date");
});

test("the counts line and the scan label are two lines", () => {
  assert.equal(screenCountsText(screen), "118 of 131 scanned · 34 matched · showing 2");
  assert.equal(scanBuiltText(screen), "Scan 1 · run at Tue 2026-03-10 8:30 AM ET · data through 8:15 AM");
  assert.equal(scanBuiltText(emptyScreen), "Not scanned yet");
  assert.equal(neverScanned(emptyScreen), true);
  assert.equal(neverScanned(screen), false);
  assert.equal(filtersNote(2), "Saved filters · a name that passes either one is listed");
  assert.equal(filtersNote(1), "Saved filters");
  assert.equal(sourceNote(screen), "Source: Alpaca SIP bars up to 8:15 AM ET · nothing after the scan time is shown");
});

test("the universe note states the Desk set and its size, then what else the server said", () => {
  const universe = { size: 131, label: "Practice universe · 131 symbols the Desk has scanned", footnote: "Practice universe · 131 symbols the Desk has scanned" };
  assert.equal(universeNote(universe), "Universe: today's Desk set, up to 250 names by today's dollar volume (131 names here). It can differ from the names that traded then.");
  const more = { ...universe, footnote: `${universe.label} · Gap up scans your Movers list as it is today · capped at 250 by dollar volume` };
  assert.equal(universeNote(more).endsWith("Gap up scans your Movers list as it is today · capped at 250 by dollar volume."), true);
});

test("a date the Desk recorded keeps the server's note instead of the line about today's set (02o-b2)", () => {
  const note = "Practice universe · the 118 symbols the Desk scanned that morning, as recorded";
  const recorded = { size: 116, label: note, footnote: `${note} · Gap up scans your Movers list as it is today`, membership: { source: "universe_days" as const, recorded_size: 118, scanned_size: 116, note } };
  assert.equal(universeNote(recorded), recorded.footnote);
  assert.equal(universeNote({ ...recorded, membership: { ...recorded.membership, source: "today" as const } }).startsWith("Universe: today's Desk set"), true);
});

test("a Screen says where its names came from, and an older one without that still parses", () => {
  const recorded = { source: "universe_days", recorded_size: 118, scanned_size: 116, note: "Practice universe · the 118 symbols the Desk scanned that morning, as recorded · 2 of them were not in your plan's prepared set and are left out" };
  const withMembership = ScreenSchema.parse({ ...screen, universe: { ...screen.universe, membership: recorded } });
  assert.equal(withMembership.universe.membership?.source, "universe_days");
  assert.equal(ScreenSchema.parse(screen).universe.membership ?? null, null);
  assert.equal(ScreenSchema.safeParse({ ...screen, universe: { ...screen.universe, membership: { ...recorded, source: "memory" } } }).success, false);
  assert.equal(containsPracticeBannedTerm(recorded.note), false);
});

test("the recorded-universe answer parses with and without a date, and a bad date is refused", () => {
  const base = { coverage: { first_day: null, last_day: null, days: 0 }, first_day_default: null, first_day_note: "The Desk has not recorded a morning's universe yet · the default start is three months back", day: null };
  assert.equal(UniverseDaysSchema.parse(base).first_day_default, null);
  const ready = { ...base, coverage: { first_day: "2026-09-28", last_day: "2026-10-23", days: 20 }, first_day_default: "2026-09-28", day: { day: "2026-09-28", recorded: true, size: 2, symbols: ["FLAT", "GAPPER"], note: "x" } };
  assert.equal(UniverseDaysSchema.parse(ready).day?.symbols.length, 2);
  assert.equal(UniverseDaysSchema.safeParse({ ...ready, first_day_default: "soon" }).success, false);
});

test("the risk plan reads as one sentence, its limits count per ET date; no limits says so", () => {
  assert.equal(riskPlanText({ tradeOnlyOnSignal: "yes", maxLossUsd: 600, maxTrades: 3 }), "Risk plan comes from the thread: trade only on a signal, max loss $600, up to 3 trades per ET date.");
  assert.equal(riskPlanText({ tradeOnlyOnSignal: "no" }), "Risk plan comes from the thread: no limits set");
  assert.equal(riskPlanText({ tradeOnlyOnSignal: "no", maxTrades: 1 }), "Risk plan comes from the thread: up to 1 trade per ET date.");
});

test("D-236: the earnings dash keeps 'checked, no report' apart from 'not checked' in its tooltip, never in a second spelling", () => {
  const earnings = screenColumns(screen).find((column) => column.key === "earnings")!;
  const checkedNone = { ...smci, earnings_state: "none" as const };
  const notChecked = { ...smci, earnings_state: null };
  assert.equal(anet.earnings_state, "none");
  assert.deepEqual([screenCellText(earnings, checkedNone), screenCellText(earnings, notChecked)], ["—", "—"]);
  assert.equal(screenCellTitle(earnings, checkedNone), "No report before the open");
  assert.equal(screenCellTitle(earnings, notChecked), undefined);
  assert.equal(screenCellTitle(earnings, smci), undefined, "a report is a badge, not a dash");
  // Only the earnings column carries it.
  assert.equal(screenCellTitle(screenColumns(screen).find((column) => column.key === "prev_close")!, checkedNone), undefined);
  assert.equal(PRACTICE_COPY.screenEarningsNone.includes("None"), false);
});

test("D-234: the refusal of a scan names where time moves, ends in a full stop and leaves no separator hanging", () => {
  const text = rescanRefusedText("Abnormal volume waits until 10:00 AM ET · no filter has a bar to read at 9:30 AM ET");
  assert.equal(text, "Abnormal volume waits until 10:00 AM ET · no filter has a bar to read at 9:30 AM ET. Move the clock on the Summary (Play, Next open or Jump), then scan.");
  assert.equal(/·\s*$/.test(text), false);
  assert.equal(text.includes("Try again"), false);
});

test("D-234: a refusal holds for the clock minute it was made in, no longer", () => {
  assert.equal(minuteOfClock("2026-08-03T13:30:05Z"), minuteOfClock("2026-08-03T13:30:55Z"));
  assert.notEqual(minuteOfClock("2026-08-03T13:30:55Z"), minuteOfClock("2026-08-03T13:31:00Z"));
});

test("warnings: the server's reason is shown as it is; a Screen it had no reason for shows the empty state, not a second banner", () => {
  assert.deepEqual(screenWarnings(screen), ["Only 2 of the 131 scanned symbols met Gap up or Abnormal volume · loosen a filter in the Screener to widen the Screen"]);
  const why = "None of the 17 scanned symbols met Gap up or Abnormal volume · loosen a filter in the Screener to widen the Screen";
  assert.deepEqual(screenWarnings({ warnings: [why] }), [why]);
  assert.deepEqual(screenWarnings({ warnings: [] }), []);
  assert.equal(why.includes("Only 0"), false);
});

// ---- the candidate table -----------------------------------------------------------------------------------

test("D-018: Prev RVOL and Prev change % are the candidate's own previous-session figures; the server's relabelled columns are not drawn twice", () => {
  const columns = screenColumns(screen);
  assert.deepEqual(columns.map((column) => column.label), ["List price", "vs prev close %", "Prev close", "Prev RVOL", "Prev change %", "Earnings", "Prev volume", "Since"]);
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  assert.equal(screenCellText(byKey.prev_close!, smci), "37.90");
  assert.equal(screenCellText(byKey.prev_rvol!, smci), "1.10×");
  assert.equal(screenCellText(byKey.prev_change_pct!, smci), "+1.20%");
  assert.equal(screenCellTone(byKey.prev_change_pct!, smci), "up");
  // The cell prints two decimals: a move that prints 0.00% is flat, not red or green (D-148).
  const tiny = (value: number) => ({ ...smci, prev_change_pct: value });
  assert.deepEqual([screenCellText(byKey.prev_change_pct!, tiny(-0.004)), screenCellTone(byKey.prev_change_pct!, tiny(-0.004))], ["0.00%", "flat"]);
  assert.deepEqual([screenCellText(byKey.prev_change_pct!, tiny(0.01)), screenCellTone(byKey.prev_change_pct!, tiny(0.01))], ["+0.01%", "up"]);
  assert.equal(screenCellText(byKey.prev_rvol!, anet), "—");
  assert.equal(screenCellText(byKey.earnings!, smci), "Reported before the open");
  // D-236: a name checked with no report and a name that was not checked read the same dash; the word "None" is never a cell's text.
  assert.equal(screenCellText(byKey.earnings!, anet), "—");
  assert.equal(screenCellText(byKey.earnings!, { ...smci, earnings_state: null }), "—");
  assert.equal(screenCellText(byKey.matched_since!, smci), "8:30 AM");
  assert.equal(screenCellText(byKey.volume!, smci), "1.8M");
  // A scan stored before the candidate carried the two fields, read before the open, still reads them from its previous-session block.
  const stored = { ...smci, prev_rvol: null, prev_change_pct: null };
  assert.deepEqual([screenCellText(byKey.prev_rvol!, stored), screenCellText(byKey.prev_change_pct!, stored)], ["1.10×", "+1.20%"]);
  assert.equal(filtersText(smci), "Gap up · Abnormal volume");
});

test("D-018: a scan read after the open still shows the previous session's RVOL and change %, beside the live ones", () => {
  const later = {
    ...screen,
    universe: { ...screen.universe, prev_basis: false },
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
  const columns = screenColumns(later);
  assert.deepEqual(columns.map((column) => column.label), ["List price", "vs prev close %", "Prev close", "Prev RVOL", "Prev change %", "ATR %", "RSI", "Earnings", "Change %", "RVOL", "Since"]);
  const row = { ...smci, prev_rvol: 1.1, prev_change_pct: 1.2, metrics: { ...smci.metrics, rvol_10d: 2.5, change_pct: 6.5 } };
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  assert.equal(screenCellText(byKey.prev_rvol!, row), "1.10×");
  assert.equal(screenCellText(byKey.prev_change_pct!, row), "+1.20%");
  assert.equal(screenCellText(byKey.rvol_10d!, row), "2.50×");
  assert.equal(screenCellText(byKey.change_pct!, row), "+6.50%");
  // A scan stored before the fields existed has nothing to show for them after the open: a dash, never the live value.
  const stored = { ...row, prev_rvol: null, prev_change_pct: null };
  assert.deepEqual([screenCellText(byKey.prev_rvol!, stored), screenCellText(byKey.prev_change_pct!, stored)], ["—", "—"]);
});

// ---- the table at the thread clock ------------------------------------------------------------------------------

const atClock = (live: Candidate["live"]) => ({ ...screen, candidates: screen.candidates.map((row, index) => ({ ...row, live: index === 0 ? live : null })) });
const liveSmci = { at: "2026-03-10T14:15:00Z", price: 44.5, change_pct: 17.41, today: true, metrics: { last: 44.5, change_pct: 17.41, volume: 910000, rvol_10d: 3.2, gap_pct_open: 8.9, vs_vwap_pct: 1.4 } };

test("the table follows the thread clock only when a read carries live blocks, and says which columns move", () => {
  assert.equal(liveState(screen), null, "a snapshot read has no live blocks");
  assert.deepEqual(liveState(atClock(liveSmci)), { today: true });
  assert.deepEqual(liveState(atClock({ ...liveSmci, today: false })), { today: false });
  const columns = screenColumns(atClock(liveSmci), { today: true });
  assert.deepEqual(columns.map((column) => column.label), ["Price at scan", "Price now", "vs prev close % now", "Prev close", "Prev RVOL", "Prev change %", "Earnings", "Volume now", "Since"]);
  // Prev RVOL and Prev change % stay the previous session's own figures (D-018): they never relabel to the clock's
  assert.deepEqual(columns.filter((column) => column.live).map((column) => column.key), ["price_now", "change_now", "volume"]);
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  const [first, second] = atClock(liveSmci).candidates as [Candidate, Candidate];
  // moving columns read the clock's values; the scan-time ones keep the scan's
  assert.equal(screenCellText(byKey.price_now!, first), "44.50");
  assert.equal(screenCellText(byKey.change_now!, first), "+17.41%");
  assert.equal(screenCellText(byKey.prev_rvol!, first), "1.10×");
  assert.equal(screenCellText(byKey.prev_change_pct!, first), "+1.20%");
  assert.equal(screenCellText(byKey.list_price!, first), "41.12");
  assert.equal(screenCellText(byKey.prev_close!, first), "37.90");
  assert.equal(screenCellText(byKey.matched_since!, first), "8:30 AM");
  // a name with no live block keeps the scan's value and shows a dash for the clock's price: nothing is made up
  assert.equal(screenCellText(byKey.price_now!, second), "—");
  assert.equal(screenCellText(byKey.prev_change_pct!, second), "−0.30%");
});

test("before the regular session opens only the price moves: the metric columns keep the scan's values and labels", () => {
  const columns = screenColumns(atClock({ ...liveSmci, today: false }), { today: false });
  assert.deepEqual(columns.map((column) => column.label), ["Price at scan", "Price now", "vs prev close % now", "Prev close", "Prev RVOL", "Prev change %", "Earnings", "Prev volume", "Since"]);
  assert.deepEqual(columns.filter((column) => column.live).map((column) => column.key), ["price_now", "change_now"]);
  assert.equal(screenCellText(columns.find((column) => column.key === "prev_rvol")!, atClock(liveSmci).candidates[0]!), "1.10×");
});

const AT_950 = "2026-03-10T13:50:00Z"; // 9:50 AM ET (EDT)
const clocked = (clock: string) => ({ clock, thread: screen.thread });

test("D-159: the table follows the clock from the first scan, so the columns before the read lands are the settled ones, with the moving cells pending", () => {
  const first = followState(clocked(AT_950), screen, { landed: false, failed: false });
  assert.deepEqual(first, { today: true, pending: true });
  const settled = followState(clocked(AT_950), atClock(liveSmci), { landed: true, failed: false });
  assert.deepEqual(settled, { today: true, pending: false });
  assert.deepEqual(screenColumns(screen, first).map((column) => [column.key, column.label, column.live]), screenColumns(screen, settled).map((column) => [column.key, column.label, column.live]), "nothing is added or relabelled when the read lands");
  assert.deepEqual(screenColumns(screen, first).filter((column) => column.live).map((column) => column.key), ["price_now", "change_now", "volume"]);
});

test("D-159: before the regular open only the price columns follow the clock, and the estimate agrees with the read", () => {
  const early = clocked("2026-03-10T12:45:00Z"); // 8:45 AM ET
  assert.deepEqual(followState(early, screen, { landed: false, failed: false }), { today: false, pending: true });
  assert.deepEqual(followState(early, atClock({ ...liveSmci, today: false }), { landed: true, failed: false }), { today: false, pending: false });
  assert.equal(followState(clocked("2026-03-10T13:30:00Z"), screen, { landed: false, failed: false })?.today, false, "9:30:00: no regular bar has closed yet");
  assert.equal(followState(clocked("2026-03-10T13:31:00Z"), screen, { landed: false, failed: false })?.today, true, "9:31: the first one has");
});

test("D-159: a failed read leaves dashes, not placeholders for ever; a closed thread or an empty Screen does not follow the clock", () => {
  assert.equal(followState(clocked(AT_950), screen, { landed: false, failed: true })?.pending, false);
  assert.equal(followState({ clock: AT_950, thread: { ...screen.thread!, status: "closed" } }, screen, { landed: true, failed: false }), null, "a closed thread's time is frozen");
  assert.equal(followState(clocked(AT_950), { candidates: [] }, { landed: true, failed: false }), null, "no names: the empty state shows, not a table to follow");
});

test("a thread clock before 9:30 AM ET, or none, is before the open; 9:30 and later is not, whatever the date", () => {
  assert.equal(beforeOpen(null), true);
  assert.equal(beforeOpen("2026-03-10T13:29:59Z"), true);
  assert.equal(beforeOpen("2026-03-10T13:30:00Z"), false);
  assert.equal(beforeOpen("2026-03-10T20:30:00Z"), false, "4:30 PM ET is past it too");
  assert.equal(beforeOpen("2026-03-14T14:00:00Z"), false, "a Saturday clock is ordinary time");
});

// ---- stars and the names she opened -------------------------------------------------------------------------------

test("stars toggle, keep order, and never refuse a name (a Screen has no cap)", () => {
  assert.deepEqual(toggledStars([{ symbol: "A" }], "B"), ["A", "B"]);
  assert.deepEqual(toggledStars([{ symbol: "A" }, { symbol: "B" }], "A"), ["B"]);
  const many = Array.from({ length: 60 }, (_, i) => ({ symbol: `M${i}` }));
  assert.deepEqual(toggledStars(many, "NEW"), [...many.map((star) => star.symbol), "NEW"]);
  assert.equal(toggledStars(many, "M0").length, 59);
  assert.equal(isStarred(screen.watch, "SMCI"), true);
  assert.equal(isStarred(screen.watch, "ANET"), false);
});

test("no copy says a Screen is limited to N names or asks her to unstar one first", () => {
  for (const [key, text] of Object.entries(PRACTICE_COPY)) {
    assert.doesNotMatch(String(text), /limits a day|unstar one first|star at most|names a day/i, key);
  }
});

const smciLong = { trade_no: 1, side: "long" as const, shares: 100, entry_price: 812.4, entry_at: "2026-03-10T13:40:00Z", stop_price: null, last_price: 814.54, unrealized_usd: 214, r: null };
const lane = (symbol: string, id: number, changes: Partial<(typeof screen)["lanes"][number]> = {}) => ({
  id,
  symbol,
  status: "active" as const,
  revealed_through: "2026-03-10T14:00:00Z",
  behind_clock: false,
  has_open_trade: false,
  trades: 0,
  realized_usd: 0,
  position: null,
  ...changes,
});

test("the names she opened list the held ones first, in the order she opened them; each reads its position marked at T", () => {
  const lanes = [lane("ANET", 1), lane("SMCI", 2, { has_open_trade: true, position: smciLong }), lane("NVDA", 3), lane("TSLA", 4, { has_open_trade: true, position: { ...smciLong, side: "short" as const, unrealized_usd: -35.5 } })];
  assert.deepEqual(heldFirst(lanes).map((item) => item.symbol), ["SMCI", "TSLA", "ANET", "NVDA"]);
  assert.equal(laneLine(lanes[1]!), "Long 100 @ $812.40 · +$214.00");
  assert.equal(laneLine(lanes[3]!), "Short 100 @ $812.40 · −$35.50");
  assert.equal(laneLine(lanes[0]!), "Flat");
  assert.equal(ScreenSchema.parse({ ...screen, lanes }).lanes.length, 4);
});

// ---- scan at the thread clock (02o-b2) ---------------------------------------------------------------------------

const scan = { seq: 2, as_of: "2026-03-10T14:00:00Z", data_through: "2026-03-10T13:45:00Z", new_count: 1, created_at: "2026-03-10T14:00:04Z" };
const job = { state: "running" as const, as_of: "2026-03-10T14:00:00Z", done: 0, total: 0, message: null };
// The scan repopulated the Screen: the second name is new in this scan, and the third was kept (opened) though it no longer matches.
const repopulated = {
  ...screen,
  clock: "2026-03-10T14:00:00Z",
  rescan: scan,
  rescan_job: { ...job, state: "done" as const, done: 3, total: 3 },
  universe: { ...screen.universe, shown: 2, matches_total: 3 },
  candidates: [
    { ...smci, new_since_list: false },
    { ...anet, new_since_list: true },
    { ...anet, symbol: "KEPT", held_over: true },
  ],
};

test("a Screen with a scan and its job parses, and every name must say whether it is new or kept", () => {
  const parsed = ScreenSchema.parse(repopulated);
  assert.deepEqual(parsed.candidates.map((candidate) => [candidate.new_since_list, candidate.held_over]), [[false, false], [true, false], [false, true]]);
  assert.equal(parsed.rescan_job?.state, "done");
  const bare: Record<string, unknown> = { ...repopulated.candidates[0]! };
  delete bare.held_over;
  assert.equal(ScreenSchema.safeParse({ ...repopulated, candidates: [bare] }).success, false);
  assert.equal(ScreenSchema.safeParse({ ...repopulated, rescan_job: undefined }).success, false); // null is the empty answer, not a missing key
  assert.equal(ScreenSchema.safeParse({ ...repopulated, rescan_job: { ...job, state: "paused" } }).success, false);
});

test("a scan is offered on an active thread whatever the time is, and not on a closed one", () => {
  assert.equal(canRescan(emptyScreen), true, "a new Screen is scanned for the first time");
  assert.equal(canRescan(screen), true);
  assert.equal(canRescan({ thread: { ...screen.thread!, status: "closed" } }), false);
});

test("the scan says the clock it ran at with its date, where its data stops, and what is new", () => {
  const label = rescanLabel(scan);
  assert.match(label, /^Scan 2 · run at Tue 2026-03-10 10:00 AM ET · data through 9:45 AM$/);
  const counts = rescanCounts(repopulated);
  assert.equal(counts, "2 of 3 matched · 1 new in this scan · 1 kept because you opened or starred them");
  assert.equal(heldOverCount(repopulated), 1);
  assert.equal(rescanCounts({ ...repopulated, candidates: repopulated.candidates.slice(0, 2) }), "2 of 3 matched · 1 new in this scan");
  for (const text of [label, counts]) assert.equal(containsPracticeBannedTerm(text), false, text);
  assert.doesNotMatch(counts, /2026|Mar/); // the counts name no date; the scan's label names its own (D-221)
});

test("a running scan says it is counting, then how many names it has read, then that it is applying the filters", () => {
  assert.equal(rescanRunning({ rescan_job: job }), true);
  assert.equal(rescanRunning({ rescan_job: { ...job, state: "done" } }), false);
  assert.equal(rescanRunning({ rescan_job: null }), false);
  assert.equal(rescanProgressText(job), "Scanning at 10:00 AM ET · counting the names to read…");
  const reading = { ...job, done: 37, total: 134 };
  assert.equal(rescanProgressText(reading), "Scanning at 10:00 AM ET · read 37 of 134 names (27%)");
  assert.equal(rescanPercent(reading), 27);
  assert.equal(rescanPercent(job), 0);
  assert.equal(rescanProgressText({ ...job, done: 134, total: 134 }), "Scanning at 10:00 AM ET · applying your filters to 134 names…");
  for (const text of [rescanProgressText(job), rescanProgressText(reading), PRACTICE_COPY.screenRescanDone, PRACTICE_COPY.screenRescanCurrent]) {
    assert.equal(containsPracticeBannedTerm(text), false, text);
    assert.doesNotMatch(text, /2026|Mar/);
  }
});

test("a scan at the thread clock is current; the clock moving past it makes it older", () => {
  assert.equal(rescanCurrent({ clock: "2026-03-10T14:00:00Z", rescan: scan }), true);
  assert.equal(rescanCurrent({ clock: "2026-03-10T14:01:00Z", rescan: scan }), false);
  assert.equal(rescanCurrent({ clock: "2026-03-10T14:00:00Z", rescan: null }), false, "a new Screen is never current");
});

test("a scan older than the thread clock says so, and a current one does not", () => {
  assert.equal(rescanStaleText({ clock: "2026-03-10T14:00:00Z", rescan: scan }), null);
  assert.equal(rescanStaleText({ clock: "2026-03-10T14:00:00Z", rescan: null }), null);
  const stale = rescanStaleText({ clock: "2026-03-10T14:30:00Z", rescan: scan });
  assert.equal(stale, "The thread clock is now 10:30 AM ET · this scan is older. Re-scan to update it.");
  assert.equal(containsPracticeBannedTerm(stale ?? ""), false);
  // The scan is old across days as well: a Jump over a weekend leaves the scan where it was run.
  assert.match(rescanStaleText({ clock: "2026-03-16T14:30:00Z", rescan: scan }) ?? "", /^The thread clock is now 10:30 AM ET/);
});

test("the strings the Screen builds contain no banned term", () => {
  const built = [
    screenTitle(screen),
    screenCountsText(screen),
    scanBuiltText(screen),
    scanBuiltText(emptyScreen),
    universeNote(screen.universe),
    sourceNote(screen),
    filtersNote(2),
    riskPlanText({ tradeOnlyOnSignal: "yes", maxLossUsd: 600, maxTrades: 3 }),
    laneLine(lane("SMCI", 2, { has_open_trade: true, position: smciLong })),
    PRACTICE_COPY.screenNoSetup,
    PRACTICE_COPY.screenNoSetupHint,
    PRACTICE_COPY.screenNoScanTitle,
    PRACTICE_COPY.screenNoNamesTitle,
    PRACTICE_COPY.screenNoNamesHint,
    PRACTICE_COPY.screenRescanHint,
    PRACTICE_COPY.screenRescanClosed,
    PRACTICE_COPY.screenLaneBehind,
    PRACTICE_COPY.screenLanesEmpty,
    ...screen.warnings,
    screen.universe.footnote,
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
  assert.equal(plan.thread_id, 1);
});
