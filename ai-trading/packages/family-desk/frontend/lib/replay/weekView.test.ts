import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { WeekSchema } from "./swingApi.ts";
import { weekClosed, weekRows, weekToDate } from "./swingFixtures.ts";
import {
  filterQualityLine,
  focusUntradedLines,
  heatStrip,
  signedPts,
  sourceQualityLine,
  startWeekAction,
  weekChecks,
  weekDayRows,
  weekEquitySeries,
  weekHeading,
  weekHoldRows,
  weekReviewable,
  weekRowView,
  weekSelectionLine,
  weekSelectionText,
  weekTiles,
} from "./weekView.ts";

const tile = (tiles: ReturnType<typeof weekTiles>, id: string) => tiles.find((item) => item.id === id)!;

test("the fixtures are real week payloads", () => {
  assert.equal(WeekSchema.parse(weekClosed).review.holds.length, 2);
  assert.equal(WeekSchema.parse(weekToDate).to_date, "yes");
});

test("points are signed with a real minus and a plus, and a zero has no sign", () => {
  assert.equal(signedPts(1.84), "+1.8 pts");
  assert.equal(signedPts(-0.6), "−0.6 pts");
  assert.equal(signedPts(0.04), "0.0 pts");
  assert.equal(signedPts(-0.04), "0.0 pts");
  assert.equal(signedPts(null), "—");
  assert.ok(signedPts(-2).includes("−"));
});

test("the tiles read in order with formatted figures, signs and tones", () => {
  const tiles = weekTiles(weekClosed.review);
  assert.deepEqual(tiles.map((item) => item.id), ["realized", "unrealized", "equity_change", "balance", "win_rate", "days_held", "gap_share", "adherence", "selection", "timing", "spy", "universe"]);
  assert.deepEqual([tile(tiles, "realized").value, tile(tiles, "realized").tone, tile(tiles, "realized").sub], ["+$612.00", "up", "holds closed this week"]);
  assert.deepEqual([tile(tiles, "unrealized").value, tile(tiles, "equity_change").value, tile(tiles, "balance").value], ["+$258.00", "+$870.00", "$50,612.00"]);
  assert.deepEqual([tile(tiles, "win_rate").value, tile(tiles, "win_rate").sub], ["100%", "average win +$612.00 · average loss —"]);
  assert.deepEqual([tile(tiles, "days_held").value, tile(tiles, "gap_share").value, tile(tiles, "gap_share").sub, tile(tiles, "adherence").value], ["3.0 days", "26%", "Gap +$230.00", "88%"]);
  assert.deepEqual([tile(tiles, "selection").value, tile(tiles, "selection").tone, tile(tiles, "timing").value, tile(tiles, "timing").tone], ["+1.8 pts", "up", "−0.6 pts", "down"]);
  assert.deepEqual([tile(tiles, "spy").value, tile(tiles, "universe").value, tile(tiles, "universe").sub], ["+0.9%", "+0.7%", "median +0.4%"]);
});

test("a figure that could not be computed is a dash, never a guess; to date changes the sub-lines only", () => {
  const empty = { ...weekClosed.review.tiles, realized_usd: null, unrealized_change_usd: null, equity_change_usd: null, balance_usd: null, win_rate: null, avg_win_usd: null, avg_loss_usd: null, avg_days_held: null, gap_usd: null, gap_share_pct: null, adherence_pct: null, selection_pts: null, timing_pts: null, spy_return_pct: null, universe_median_return_pct: null, universe_mean_return_pct: null };
  const tiles = weekTiles({ tiles: empty });
  for (const item of tiles) {
    assert.equal(item.value, "—", item.id);
    assert.equal(item.tone, "flat", item.id);
    assert.equal(containsPracticeBannedTerm(`${item.label} ${item.sub}`), false);
  }
  assert.equal(tile(tiles, "win_rate").sub, "no holds closed yet");
  assert.equal(tile(tiles, "gap_share").sub, "no carried holds");
  assert.equal(tile(weekTiles(weekClosed.review, true), "realized").sub, "holds closed so far");
  assert.equal(tile(weekTiles({ tiles: { ...weekClosed.review.tiles, gap_share_pct: -12.4 } }), "gap_share").value, "−12%");
  // D-070: a gap bigger than the week's whole change is not printed as 315%
  const over = tile(weekTiles({ tiles: { ...weekClosed.review.tiles, gap_usd: -113.51, gap_share_pct: 315.3 } }), "gap_share");
  assert.deepEqual([over.value, over.sub], ["Over 100%", "Gap −$113.51 · more than the week's whole change"]);
});

test("the selection sentence is the API's line; without one the plain reason shows", () => {
  assert.equal(weekSelectionLine(weekClosed.review), "Selection +1.8 pts vs the universe median · your hold ranked 4th of 50 · Timing −0.6 pts");
  assert.equal(weekSelectionLine(weekToDate.review), null);
  assert.equal(weekSelectionText(weekClosed.review), weekClosed.review.copy[0]);
  assert.equal(weekSelectionText({ copy: [], holds: [] }), "No holds this week · selection and timing score your holds against the universe");
  assert.equal(weekSelectionText({ copy: [], holds: weekClosed.review.holds }), "Selection and timing need a hold with a full price history");
});

test("the equity series has a balance and an equity point per close, this week flagged, on a stand-in timeline", () => {
  const closed = weekEquitySeries(weekClosed.review);
  assert.equal(closed.points.length, 5);
  assert.ok(closed.points.every((point) => point.inWeek));
  assert.deepEqual(closed.balance, [50000, 50000, 50000, 50612, 50612]);
  assert.deepEqual(closed.equity, [50085, 50275, 50210, 50720, 50870]);
  assert.equal(closed.points[2]!.label, "D3");
  assert.equal(closed.points[0]!.t, "2001-01-01", "real dates never reach the chart");

  const toDate = weekEquitySeries(weekToDate.review);
  assert.equal(toDate.points.length, 7);
  assert.deepEqual(toDate.points.map((point) => point.inWeek), [false, false, false, false, false, true, true]);
  assert.deepEqual([toDate.weekFirstDay, toDate.weekLastDay], [6, 7]);
  assert.deepEqual(toDate.bars.map((bar) => bar.ext), toDate.points.map((point) => point.inWeek));
  assert.ok(toDate.bars.every((bar, index) => bar.c === toDate.equity[index] && bar.o === bar.c && bar.h === bar.c && bar.l === bar.c));
  assert.equal(new Set(toDate.points.map((point) => point.t)).size, 7, "one stand-in date per close");
  assert.deepEqual(weekEquitySeries({ equity: [], week: weekClosed.review.week }).points, []);
});

test("the days table: day and weekday, watched or passed, and the three results", () => {
  const rows = weekDayRows(weekClosed.review);
  assert.equal(rows.length, 5);
  assert.deepEqual([rows[1]!.title, rows[1]!.watched, rows[1]!.entries, rows[1]!.adherence], ["Day 2 · Tue", "Watched", "1", "100%"]);
  assert.deepEqual([rows[2]!.watched, rows[2]!.gap, rows[2]!.gapTone, rows[2]!.intraday, rows[2]!.intradayTone, rows[2]!.adherence], ["Passed", "+$230.00", "up", "−$295.00", "down", "—"]);
  assert.deepEqual([rows[0]!.realized, rows[0]!.realizedTone, rows[3]!.realized, rows[3]!.exits], ["$0.00", "flat", "+$612.00", "1"]);
  assert.equal(rows[3]!.dayNo, 4);
});

test("the holds table: entry and exit, days held, P/L, R, gap, stop wording, rank and the two edges", () => {
  const [tsla, nvda] = weekHoldRows(weekClosed.review);
  assert.deepEqual(
    [tsla!.symbol, tsla!.side, tsla!.shares, tsla!.entry, tsla!.exit, tsla!.held, tsla!.pnl, tsla!.pnlTone, tsla!.r, tsla!.gap, tsla!.stop, tsla!.rank, tsla!.selection, tsla!.timing],
    ["TSLA", "Long", "40", "Day 2 · 240.50", "Day 4 · 255.80", "3 days held", "+$612.00", "up", "+1.80R", "+$230.00", "Stop set", "4th of 50", "+2.4 pts", "−0.5 pts"],
  );
  assert.deepEqual([nvda!.exit, nvda!.held, nvda!.gap, nvda!.stop, nvda!.rank, nvda!.selection, nvda!.timing], ["open · Fri close", "1 day held", "—", "No stop", "—", "—", "—"]);
  const away = weekHoldRows({ ...weekClosed.review, holds: [{ ...weekClosed.review.holds[0]!, stop: "away" }, { ...weekClosed.review.holds[0]!, stop: "honored" }] });
  assert.deepEqual(away.map((row) => [row.stop, row.stopAway]), [["Crossed while away", true], ["Stop honored", false]]);
  assert.equal(weekHoldRows({ ...weekClosed.review, holds: [weekClosed.review.holds[1]!], days: [] })[0]!.exit, "open · week close", "no day to name the close by");
});

test("the heat strip runs best to worst, ties by symbol, with holds and focus names marked", () => {
  const heat = heatStrip({ heat: [...weekClosed.review.heat].reverse() });
  assert.deepEqual(heat.map((item) => item.symbol), ["COIN", "NVDA", "TSLA", "META", "UBER", "AMD", "LQ01"]);
  assert.deepEqual(heat.map((item) => item.kind), ["both", "both", "held", "none", "focus", "held", "none"]);
  assert.deepEqual([heat[0]!.returnText, heat[0]!.tone, heat[0]!.sourceLabel, heat[5]!.returnText, heat[5]!.tone], ["+9.4%", "up", "Filter", "−2.3%", "down"]);
  assert.equal(heat[0]!.label, "COIN, +9.4%, held and focus name");
  assert.equal(heat[2]!.label, "TSLA, +3.1%, practice hold");
  assert.equal(heat[4]!.label, "UBER, +0.4%, focus name");
  assert.equal(heat[3]!.label, "META, +0.4%");
  assert.equal(heatStrip({ heat: [{ symbol: "X", source: null, return_pct: 0, held: "no", focus: "no" }] })[0]!.sourceLabel, "—");
});

test("the adherence checks keep a check that did not apply apart from a pass", () => {
  const checks = weekChecks(weekClosed.review);
  assert.deepEqual(checks.map((check) => [check.id, check.state]), [
    ["stop_set", "pass"],
    ["stop_honored", "na"],
    ["week_loss_limit", "pass"],
    ["focus_before_open", "fail"],
  ]);
  assert.equal(checks[3]!.detail, "1 of 2 entries");
});

test("filter, source and untraded lines", () => {
  assert.equal(filterQualityLine(weekClosed.review.filter_quality), "Names your filters flagged (6): median +1.2% vs universe median +0.4% · edge +0.8 pts");
  assert.equal(filterQualityLine(null), null);
  assert.equal(sourceQualityLine(weekClosed.review.source_quality), "Watchlist +1.4% · liquidity +0.3%");
  assert.equal(sourceQualityLine([]), null);
  assert.deepEqual(focusUntradedLines(weekClosed.review.focus_untraded), ["COIN would have ranked 1st of 50 (+9.4%)"]);
});

test("the heading says Week to date while the week is open and Final once frozen", () => {
  assert.deepEqual(weekHeading(weekClosed), { title: "Week 1", badge: "Final", note: null });
  // D-130: a week can be final while holds ride on; the chip says so.
  assert.equal(weekHeading(weekClosed, 2).badge, "Final · 2 holds open");
  assert.equal(weekHeading(weekClosed, 1).badge, "Final · 1 hold open");
  assert.equal(weekHeading(weekToDate, 2).badge, "Week to date", "an open week keeps its own word");
  assert.deepEqual(weekHeading(weekToDate), { title: "Week 2 · 2 of 5 days", badge: "Week to date", note: "Through the last finished day's close · not final yet" });
  assert.equal(weekHeading({ label: "Week 3", to_date: "no", status: "open" }).badge, "Open");
});

test("Start Week appears only when the reviewed week is the one just finished", () => {
  assert.deepEqual(startWeekAction({ next: "week_review", week_no: 2 }, 1), { label: "Start Week 2", weekNo: 2 });
  assert.equal(startWeekAction({ next: "day", week_no: 2 }, 1), null, "the next day is already open");
  assert.equal(startWeekAction({ next: "week_review", week_no: 3 }, 1), null, "an older review");
  assert.equal(startWeekAction({ next: "finished", week_no: 4 }, 3), null, "nothing left to start");
  assert.equal(startWeekAction(null, 1), null);
});

test("the thread's week rows: figures for a closed week, dashes for the open one, and which rows link", () => {
  const closed = weekRowView(weekRows[0]!);
  assert.deepEqual(
    [closed.label, closed.days, closed.status, closed.realized, closed.equityChange, closed.adherence, closed.selection, closed.timing],
    ["Week 1", "5 days", "Final", "+$612.00", "+$870.00", "88%", "+1.8 pts", "−0.6 pts"], // D-130: the same word as the week page's chip
  );
  const open = weekRowView(weekRows[1]!);
  assert.deepEqual([open.status, open.realized, open.equityChange, open.adherence, open.selection, open.timing], ["Week to date", "—", "—", "—", "—", "—"]);
  assert.equal(weekRowView({ ...weekRows[0]!, days: 1 }).days, "1 day");
  assert.equal(weekReviewable(weekRows[0]!, 0), true);
  assert.equal(weekReviewable(weekRows[1]!, 5), false, "no finished day of week 2 yet");
  assert.equal(weekReviewable(weekRows[1]!, 6), true);
});

test("every string the week helpers build avoids the Practice banned words", () => {
  const built: Array<string | null> = [];
  for (const week of [weekClosed, weekToDate]) {
    const heading = weekHeading(week);
    built.push(heading.title, heading.badge, heading.note, weekSelectionText(week.review), filterQualityLine(week.review.filter_quality), sourceQualityLine(week.review.source_quality));
    for (const item of weekTiles(week.review, week.to_date === "yes")) built.push(item.label, item.value, item.sub);
    for (const row of weekDayRows(week.review)) built.push(row.title, row.watched, row.realized, row.gap, row.intraday, row.adherence);
    for (const row of weekHoldRows(week.review)) built.push(row.entry, row.exit, row.held, row.pnl, row.r, row.gap, row.stop, row.rank, row.selection, row.timing);
    for (const item of heatStrip(week.review)) built.push(item.label, item.sourceLabel);
    for (const check of weekChecks(week.review)) built.push(check.label, check.detail);
    built.push(...focusUntradedLines(week.review.focus_untraded));
  }
  for (const row of weekRows) {
    const view = weekRowView(row);
    built.push(view.label, view.days, view.status, view.realized, view.equityChange, view.adherence, view.selection, view.timing);
  }
  built.push(startWeekAction({ next: "week_review", week_no: 2 }, 1)!.label);
  for (const text of built) if (text !== null) assert.equal(containsPracticeBannedTerm(text), false, text);
  assert.ok(built.length > 80);
});
