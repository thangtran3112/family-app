import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import {
  boardCellText,
  boardCellTone,
  daySummaryTiles,
  daysHeldText,
  earningsText,
  endDayHint,
  endDayPrompt,
  firstSessionSymbol,
  freeCashText,
  gapText,
  holdEntryLabel,
  holdRowView,
  holdsOpenText,
  holdStopText,
  passDayPrompt,
  pauseView,
  practiseNames,
  priceBasisLabel,
  sideLabel,
  sizingHint,
  sizingRiskUsd,
  stopDistanceText,
  stopHitText,
  stripRowView,
  swingBriefLine,
  swingCardView,
  swingDatesHidden,
  swingDayTitle,
  swingBoardTitle,
} from "./swing.ts";
import {
  amdHold,
  autoClosedHold,
  boardColumns,
  boardRows,
  closedHold,
  gappedHold,
  nvdaHold,
  pausedCross,
  pausedGap,
  splitHold,
  stripRows,
  swingBrief,
  swingDayList,
  swingDayListEnded,
  swingDaySummary,
  swingThreadFinished,
  swingThreadReviewReady,
  swingThreadSummary,
} from "./swingFixtures.ts";
import { activeThread } from "./threadFixtures.ts";

const column = (key: string) => boardColumns.find((item) => item.key === key)!;

test("a hold row reads like the board: entry day and price, days held, stop, the value it is marked at", () => {
  const row = holdRowView(nvdaHold);
  assert.deepEqual(
    [row.side, row.shares, row.entry, row.held, row.stop, row.value, row.result, row.resultTone, row.r, row.gap, row.earnings, row.splitNote, row.exit],
    ["Long", "100", "Day 5 · 184.20", "Day 2 of hold", "Stop 178.50", "Prior close 190.10", "+$590.00", "up", "+1.04R", null, "Earnings in 3 sessions · after close", null, null],
  );
  assert.equal(holdEntryLabel({ entry_day_no: 3, entry_price: 184.2 }), "Day 3 · 184.20");
  assert.equal(daysHeldText(1), "Day 1 of hold", "D-140: a count of the hold's days, not a length of time");
  assert.equal(daysHeldText(2), "Day 2 of hold");
  assert.equal(sideLabel("short"), "Short");
});

test("the API's split note is shown as it is, and a short is signed for its side", () => {
  assert.equal(holdRowView(splitHold).splitNote, "Split 10-for-1 before today's open · 100 shares are now 1,000 at 121.20");
  assert.equal(holdRowView(splitHold).shares, "1,000");
  const short = holdRowView(amdHold);
  assert.deepEqual([short.side, short.result, short.resultTone, short.r], ["Short", "+$180.00", "up", "+0.60R"]);
});

test("a crossed stop and a gap read in plain words, with the price basis of the moment", () => {
  const row = holdRowView(gappedHold);
  assert.deepEqual([row.stop, row.stopCrossed, row.value, row.result, row.resultTone, row.gap], ["Stop 178.50 crossed", true, "Last 177.40", "−$680.00", "down", "Gap −$1,270.00"]);
  assert.equal(holdRowView(gappedHold, "off").value, "Last 177.40 (1m close)");
  assert.equal(holdStopText({ stop_price: null, stop_hit: "no" }), "No stop");
});

test("a closed hold shows its exit and its final P/L; an automatic exit says so", () => {
  const her = holdRowView(closedHold);
  assert.deepEqual([her.status, her.exit, her.value, her.result, her.resultTone], ["closed", "Exit Day 4 · 255.80", "—", "+$612.00", "up"]);
  assert.equal(holdRowView(autoClosedHold).exit, "Closed at the close of Day 20 · 255.80");
  assert.equal(holdRowView(autoClosedHold).resultTone, "down");
});

test("the price label is the prior close until anything of the day is revealed, then the last price", () => {
  assert.equal(priceBasisLabel("prior_close", 187.4), "Prior close 187.40");
  assert.equal(priceBasisLabel("last", 182.1), "Last 182.10");
  assert.equal(priceBasisLabel("last", 182.35, "off"), "Last 182.35 (1m close)");
  assert.equal(priceBasisLabel("prior_close", 187.4, "off"), "Prior close 187.40");
  assert.equal(priceBasisLabel(undefined, 188.05), "Last 188.05", "a day session names no basis");
  assert.equal(priceBasisLabel(null, null), "—");
});

test("the gap has a real minus sign and a plus, and nothing before the first price", () => {
  assert.equal(gapText(-412), "Gap −$412.00");
  assert.equal(gapText(412), "Gap +$412.00");
  assert.equal(gapText(0), "Gap $0.00");
  assert.equal(gapText(null), null);
  assert.equal(gapText(undefined), null);
  assert.ok(gapText(-412)!.includes("−") && !gapText(-412)!.includes("-"));
});

test("the earnings chip counts sessions from the day", () => {
  assert.equal(earningsText({ in_sessions: 0, timing: "before open" }), "Earnings today · before open");
  assert.equal(earningsText({ in_sessions: 1, timing: "after close" }), "Earnings next session · after close");
  assert.equal(earningsText({ in_sessions: 3, timing: "after close" }), "Earnings in 3 sessions · after close");
  assert.equal(earningsText(null), null);
});

test("stop distance is signed in her favour: from the stop, at it, or past it", () => {
  assert.equal(stopDistanceText(1.84), "1.8% from your stop");
  assert.equal(stopDistanceText(0.04), "At your stop");
  assert.equal(stopDistanceText(-0.2), "0.2% past your stop");
  assert.equal(stopDistanceText(3.1, "yes"), "3.1% past your stop", "a stop that already paused play is past it");
  assert.equal(stopDistanceText(null), "No stop");
});

test("free cash and the holds-open count", () => {
  assert.equal(freeCashText(24720), "Free cash $24,720.00");
  assert.equal(freeCashText(null), "—");
  assert.deepEqual([0, 1, 2].map(holdsOpenText), ["No holds open", "1 hold open", "2 holds open"]);
});

test("the sizing hint is risk over the stop distance, capped by free cash, and only a hint", () => {
  const base = { riskUsd: 100, last: 190, stop: 185 };
  assert.deepEqual(sizingHint(base), { shares: 20, limitedBy: "risk", text: "Sizing hint · risking $100.00 to your stop means 20 shares" });
  assert.deepEqual(sizingHint({ ...base, freeCash: 1900 }), { shares: 10, limitedBy: "cash", text: "Sizing hint · your free cash buys 10 shares" });
  assert.equal(sizingHint({ ...base, freeCash: 50_000 })?.limitedBy, "risk");
  assert.equal(sizingHint({ riskUsd: 5, last: 190, stop: 185 })?.text, "Sizing hint · risking $5.00 to your stop means 1 share");
  assert.equal(sizingHint({ ...base, freeCash: 150 })?.shares, 0);
  assert.equal(sizingHint({ ...base, freeCash: 150 })?.text, "Sizing hint · your free cash does not cover one share");
  assert.equal(sizingHint({ riskUsd: 3, last: 190, stop: 185 })?.text, "Sizing hint · one share already risks more than $3.00");
  assert.equal(sizingHint({ riskUsd: 1_000_000, last: 100, stop: 99.5 })?.shares, 10_000, "a mark carries at most 10,000 shares");
  assert.equal(sizingHint({ ...base, stop: null }), null);
  assert.equal(sizingHint({ ...base, riskUsd: undefined }), null);
  assert.equal(sizingHint({ ...base, stop: 190 }), null, "no distance to the stop, nothing to size from");
  assert.equal(sizingHint({ ...base, last: null }), null);
  assert.equal(sizingRiskUsd({ riskPerHoldUsd: 100 }, { maxLossUsd: 600 }), 100);
  assert.equal(sizingRiskUsd({}, { maxLossUsd: 600 }), 600);
  assert.equal(sizingRiskUsd(null, null), undefined);
});

test("the stop pause names the hold, the stop and the minute; a gap open says where it opened; the others are listed", () => {
  const nvda = pauseView({ symbol: "NVDA", stop_price: 182.5, at: "2026-07-14T15:42:00Z", price: 182.4, kind: "cross", also: [] });
  assert.equal(nvda.headline, "NVDA crossed your stop 182.50 at 11:42");
  assert.equal(nvda.text, "NVDA crossed your stop 182.50 at 11:42 · Exit or keep");
  assert.equal(nvda.also, null);
  const gap = pauseView(pausedGap);
  assert.equal(gap.headline, "NVDA opened below your stop 182.50 at 179.10");
  assert.equal(gap.also, "AMD and TSLA also crossed");
  assert.equal(gap.text, "NVDA opened below your stop 182.50 at 179.10 · AMD and TSLA also crossed · Exit or keep");
  assert.equal(pauseView({ ...pausedGap, symbol: "AMD", stop_price: 168, price: 171.5, also: ["TSLA"] }).headline, "AMD opened above your stop 168.00 at 171.50", "a short's stop is above");
  assert.equal(pauseView({ ...pausedGap, also: ["AMD"] }).also, "AMD also crossed");
  assert.equal(pauseView(pausedCross).headline, "AMD crossed your stop 168.00 at 11:42");
});

test("a strip row shows the last price and change; a hold adds its P/L and stop distance; a stopped hold is amber", () => {
  const [nvda, amd, coin, uber] = stripRows.map(stripRowView);
  assert.deepEqual([nvda!.last, nvda!.change, nvda!.changeTone, nvda!.sub, nvda!.amber], ["191.40", "+0.7%", "up", "Long 100 · +$720.00 · 6.7% from your stop", false]);
  assert.deepEqual([amd!.sub, amd!.amber, amd!.source], ["Short 50 · −$320.00 · 0.2% past your stop", true, "hold"]);
  assert.deepEqual([coin!.last, coin!.change, coin!.sub, coin!.amber, coin!.source], ["305.10", "+1.2%", null, false, "focus"]);
  assert.deepEqual([uber!.last, uber!.change, uber!.changeTone], ["—", "—", "flat"], "no price before the day's first one");
  assert.match(amd!.label, /AMD, practice hold, last 168\.40, \+6\.3%, Short 50 · −\$320\.00 · 0\.2% past your stop, stop crossed/);
});

test("the strip's % colour follows the rounded text: -0.01% and +0.01% both read 0.0% and are flat (D-148, R-07)", () => {
  const row = (chg_pct: number | null) => stripRowView({ symbol: "S03", source: "focus", last: 100, chg_pct, hold: null });
  for (const tiny of [-0.01, 0.01, -0.04, 0.049]) {
    assert.deepEqual([row(tiny).change, row(tiny).changeTone], ["0.0%", "flat"], String(tiny));
  }
  assert.deepEqual([row(-0.06).change, row(-0.06).changeTone], ["−0.1%", "down"], "a move that shows a digit keeps its colour");
  assert.deepEqual([row(0.06).change, row(0.06).changeTone], ["+0.1%", "up"]);
  assert.equal(row(null).changeTone, "flat");
});

test("dates stay hidden unless the setup says otherwise", () => {
  assert.equal(swingDatesHidden({ hideDates: "yes" }), true);
  assert.equal(swingDatesHidden({ hideDates: "no" }), false);
  assert.equal(swingDatesHidden(undefined), true, "no setup in hand, no date");
});

test("the board header: day, week, weekday, as of the prior close, balance, equity and SIMULATED", () => {
  assert.equal(swingDayTitle(swingDayList, true), "Day 7 of 20 · Week 2 · Tue");
  assert.equal(swingDayTitle(swingDayList, false), "Day 7 of 20 · Week 2 · Tue 2026-07-14");
  assert.equal(swingBoardTitle(swingDayList, true), "Day 7 of 20 · Tue", "D-139: day and weekday; the week and the state are chips, the money is in the strip");
  assert.equal(swingBoardTitle(swingDayList, false), "Day 7 of 20 · Tue 2026-07-14");
  assert.equal(swingBriefLine(swingBrief), "Balance $51,240.00 · Equity $52,010.00 · Free cash $24,720.00 · SIMULATED");
});

test("the hub card line, the review-ready notice and the action", () => {
  const card = swingCardView(swingThreadSummary)!;
  assert.equal(card.title, "Swing · 50 names");
  assert.equal(card.line, "Swing · 50 names · Week 2 of 4 · Day 7 of 20 · 2 holds open", "D-112: week, day, names and holds; the money sits in its own cells");
  assert.deepEqual([card.notice, card.action], [null, { kind: "continue", label: "Continue Day 7", weekNo: null }]);

  const ready = swingCardView(swingThreadReviewReady)!;
  assert.equal(ready.notice, "Week 1 review ready");
  assert.deepEqual(ready.action, { kind: "review", label: "Open Week 1 review", weekNo: 1 });
  assert.match(ready.line, /1 hold open$/);

  const finished = swingCardView(swingThreadFinished)!;
  assert.equal(finished.line, "Swing · 50 names · Finished · Day 20 of 20");
  assert.equal(finished.action.kind, "none");

  const fresh = swingCardView({ ...swingThreadSummary, today: null, swing: { ...swingThreadSummary.swing!, days_ended: 0, day_no: 1, week_no: 1, holds_open: 0, equity_series: [] } })!;
  assert.deepEqual(fresh.action, { kind: "start", label: "Start Day 1", weekNo: null });
  assert.match(fresh.line, /No holds open$/);

  assert.equal(swingCardView(activeThread), null, "a day thread has no swing card");
  assert.equal(swingCardView({ ...swingThreadSummary, swing: undefined }), null);
});

test("End day names the clock and the holds that stay open; Pass names the holds that ride", () => {
  const at = "2026-07-14T15:40:00Z";
  assert.equal(endDayPrompt({ dayNo: 7, clock: at, holdsOpen: 2 }), "End Day 7 at 11:40? Your 2 holds stay open through the close, unwatched.");
  assert.equal(endDayPrompt({ dayNo: 7, clock: at, holdsOpen: 1 }), "End Day 7 at 11:40? Your 1 hold stays open through the close, unwatched.");
  assert.equal(endDayPrompt({ dayNo: 7, clock: at, holdsOpen: 0 }), "End Day 7 at 11:40? The rest of the day is shown at once.");
  assert.equal(endDayPrompt({ dayNo: 7, clock: null, holdsOpen: 2 }), "End Day 7? Your 2 holds stay open through the close, unwatched.");
  assert.deepEqual([2, 1, 0].map(endDayHint), ["2 holds stay open overnight", "1 hold stays open overnight", null]);
  assert.equal(passDayPrompt({ dayNo: 7, holdsOpen: 2 }), "Your 2 holds ride through Day 7 unwatched.");
  assert.equal(passDayPrompt({ dayNo: 7, holdsOpen: 1 }), "Your 1 hold rides through Day 7 unwatched.");
  assert.equal(passDayPrompt({ dayNo: 7, holdsOpen: 0 }), "No holds are open, so nothing rides through Day 7.");
});

test("board cells follow the API's column formats; a data gap is a dash", () => {
  const nvda = boardRows[0]!;
  assert.equal(boardCellText(column("source"), nvda), "Watchlist");
  assert.equal(boardCellText(column("prior_close"), nvda), "190.10");
  assert.equal(boardCellText(column("chg_1d_pct"), nvda), "+1.20%");
  assert.equal(boardCellText(column("atr_pct_14"), nvda), "2.90%");
  assert.equal(boardCellText(column("rvol_10d"), nvda), "1.35×");
  assert.equal(boardCellText(column("avg_dollar_volume_20d"), nvda), "21.4B");
  assert.equal(boardCellText(column("matches"), nvda), "New 20-day high");
  assert.equal(boardCellText(column("matches"), boardRows[1]!), "—");
  const gap = boardRows[3]!;
  assert.deepEqual([boardCellText(column("prior_close"), gap), boardCellText(column("chg_1d_pct"), gap)], ["—", "—"]);
  assert.equal(boardCellText({ key: "prior_close", format: "mystery" }, nvda), "190.1", "an unknown format reads as a plain number");
  assert.deepEqual([boardCellTone(column("chg_1d_pct"), nvda), boardCellTone(column("chg_1d_pct"), boardRows[1]!), boardCellTone(column("chg_1d_pct"), gap), boardCellTone(column("prior_close"), nvda)], ["up", "down", "flat", null]);
});

test("entries are for held and starred names: holds first, no duplicates; Start Day opens on a focus name, else a hold", () => {
  assert.deepEqual(practiseNames(swingDayList), ["NVDA", "AMD", "COIN"]);
  assert.equal(firstSessionSymbol(swingDayList), "NVDA");
  assert.equal(firstSessionSymbol({ watch: [], holds: [amdHold, nvdaHold] }), "AMD");
  assert.equal(firstSessionSymbol({ watch: [], holds: [closedHold] }), null, "a closed hold is not a name to open");
  assert.equal(firstSessionSymbol({ watch: [], holds: [] }), null);
  assert.deepEqual(practiseNames({ watch: [], holds: [closedHold] }), []);
});

test("an ended day is one strip of tiles, and a crossing is told as watched or while away", () => {
  const tiles = daySummaryTiles(swingDaySummary);
  assert.deepEqual(tiles.map((tile) => [tile.id, tile.value]), [
    ["realized", "+$828.00"],
    ["gap", "+$230.00"],
    ["intraday", "+$215.00"],
    ["equity_change", "+$845.00"],
    ["balance", "$51,240.00"],
    ["equity", "$52,010.00"],
    ["trades", "1 · 1"],
    ["stops", "1"],
  ]);
  assert.equal(tiles.find((tile) => tile.id === "stops")!.sub, "1 while you were away");
  assert.equal(tiles.find((tile) => tile.id === "trades")!.sub, null);
  assert.equal(daySummaryTiles({ ...swingDaySummary, passed: "yes", stop_hits: [] }).find((tile) => tile.id === "trades")!.sub, "Passed");
  assert.equal(daySummaryTiles({ ...swingDaySummary, gap_usd: -300 }).find((tile) => tile.id === "gap")!.value, "−$300.00");
  assert.equal(stopHitText({ symbol: "AMD", at: "14:05", watched: "no" }), "AMD crossed its stop at 14:05 while you were away");
  assert.equal(stopHitText({ symbol: "AMD", at: "11:42", watched: "yes" }), "AMD crossed its stop at 11:42");
});

test("every string the helpers build avoids the Practice banned words", () => {
  const built = [
    ...[nvdaHold, amdHold, splitHold, closedHold, autoClosedHold, gappedHold].flatMap((hold) => {
      const row = holdRowView(hold, "off");
      return [row.entry, row.held, row.stop, row.value, row.result, row.r, row.gap, row.earnings, row.exit, row.splitNote];
    }),
    ...[pausedCross, pausedGap].flatMap((paused) => {
      const view = pauseView(paused);
      return [view.headline, view.also, view.action, view.text];
    }),
    ...stripRows.flatMap((row) => {
      const view = stripRowView(row);
      return [view.sub, view.label];
    }),
    swingBoardTitle(swingDayList, true),
    swingBoardTitle(swingDayListEnded, false),
    swingBriefLine(swingBrief),
    ...[swingThreadSummary, swingThreadReviewReady, swingThreadFinished].flatMap((summary) => {
      const card = swingCardView(summary)!;
      return [card.title, card.line, card.notice, card.action.label];
    }),
    ...[2, 1, 0].flatMap((n) => [endDayPrompt({ dayNo: 7, clock: "2026-07-14T15:40:00Z", holdsOpen: n }), endDayHint(n), passDayPrompt({ dayNo: 7, holdsOpen: n })]),
    ...daySummaryTiles(swingDaySummary).flatMap((tile) => [tile.label, tile.value, tile.sub]),
    stopHitText({ symbol: "AMD", at: "14:05", watched: "no" }),
    sizingHint({ riskUsd: 100, last: 190, stop: 185 })?.text,
    sizingHint({ riskUsd: 100, last: 190, stop: 185, freeCash: 1900 })?.text,
    sizingHint({ riskUsd: 100, last: 190, stop: 185, freeCash: 100 })?.text,
    sizingHint({ riskUsd: 3, last: 190, stop: 185 })?.text,
    stopDistanceText(1.5),
    stopDistanceText(-1.5),
    priceBasisLabel("last", 1, "off"),
    gapText(-3),
    freeCashText(1),
  ];
  for (const text of built) if (text != null) assert.equal(containsPracticeBannedTerm(text), false, text);
});
