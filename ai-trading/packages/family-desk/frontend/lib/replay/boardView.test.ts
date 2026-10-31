import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { sortRows } from "../desk/sort.ts";
import {
  boardColumns,
  boardSortValue,
  boardStart,
  canPass,
  dayOpenClock,
  endedDayView,
  heldSides,
  lateStars,
  lateStarsText,
  resumeDayLabel,
  prepStep,
  starEntry,
  trustedSwingState,
} from "./boardView.ts";
import { PREVIEW_POLL_MAX_MS } from "./hubSwing.ts";
import type { SwingState } from "./threads.ts";
import { amdHold, boardColumns as apiColumns, boardRows, closedHold, nvdaHold, swingDayList, swingOpenNext, swingOpenNextWaiting, swingState } from "./swingFixtures.ts";

test("the columns are the API's, then Earnings; text columns read left, numbers right; the lowest-value ones drop at 1180", () => {
  const columns = boardColumns(apiColumns);
  assert.deepEqual(columns.map((column) => column.key), [...apiColumns.map((column) => column.key), "earnings"]);
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
  assert.deepEqual([byKey.source!.align, byKey.matches!.align, byKey.earnings!.align, byKey.prior_close!.align, byKey.rsi_14!.align], ["left", "left", "left", "right", "right"]);
  assert.deepEqual([byKey.source!.firstSort, byKey.earnings!.firstSort, byKey.matches!.firstSort, byKey.chg_1d_pct!.firstSort], ["asc", "asc", "desc", "desc"]);
  const dropped = columns.filter((column) => column.priority !== undefined).sort((a, b) => a.priority! - b.priority!).map((column) => column.key);
  assert.deepEqual(dropped, ["avg_dollar_volume_20d", "vs_50d_avg_pct", "chg_5d_pct", "rsi_14"]);
  assert.equal(byKey.prior_close!.priority, undefined, "the price and the day's change are never dropped");
  assert.equal(byKey.matches!.priority, undefined);
});

test("header clicks sort by the figure, the source order, the match count or the soonest report; a data gap goes last", () => {
  const [nvda, amd, coin, gap] = boardRows as [(typeof boardRows)[0], (typeof boardRows)[0], (typeof boardRows)[0], (typeof boardRows)[0]];
  const order = (key: string, direction: "asc" | "desc") => sortRows(boardRows, (row) => boardSortValue(key, row), direction).map((row) => row.symbol);
  assert.deepEqual(order("chg_1d_pct", "desc"), [coin.symbol, nvda.symbol, amd.symbol, gap.symbol]);
  assert.deepEqual(order("chg_1d_pct", "asc"), [amd.symbol, nvda.symbol, coin.symbol, gap.symbol], "empty stays last in either direction");
  assert.deepEqual(order("symbol", "asc"), ["AMD", "COIN", "LQ01", "NVDA"]);
  assert.deepEqual(order("source", "asc"), ["NVDA", "AMD", "COIN", "LQ01"], "watchlist, manual, filter, liquidity");
  assert.deepEqual(order("matches", "desc").slice(0, 2), ["NVDA", "COIN"]);
  assert.deepEqual(order("earnings", "asc"), ["NVDA", "AMD", "COIN", "LQ01"], "the only chip comes first, the rest keep their order");
  assert.equal(boardSortValue("earnings", nvda), 3);
  assert.equal(boardSortValue("prior_close", gap), null);
  assert.equal(boardSortValue("no_such_column", nvda), null);
});

test("holds are tagged by side on the board; a closed hold is not a name she holds", () => {
  assert.deepEqual(heldSides([nvdaHold, amdHold, closedHold]), { NVDA: "Long", AMD: "Short" });
  assert.deepEqual(heldSides([]), {});
});

test("a star is stamped with the day clock, else the open; only stars after the open are late", () => {
  assert.equal(dayOpenClock("2026-07-14"), "2026-07-14T13:30:00.000Z", "09:30 ET in July");
  assert.equal(dayOpenClock("2026-01-13"), "2026-01-13T14:30:00.000Z", "09:30 ET in January");
  assert.deepEqual(starEntry({ clock: null, day: "2026-07-14" }, "UBER"), { symbol: "UBER", starred_clock: "2026-07-14T13:30:00.000Z" });
  assert.deepEqual(starEntry({ clock: "2026-07-14T15:00:00Z", day: "2026-07-14" }, "UBER"), { symbol: "UBER", starred_clock: "2026-07-14T15:00:00Z" });
  const watch = [
    { symbol: "NVDA", starred_clock: "2026-07-14T13:30:00Z" },
    { symbol: "COIN", starred_clock: "2026-07-14T15:05:00Z" },
  ];
  assert.deepEqual(lateStars({ watch, day: "2026-07-14" }), ["COIN"]);
  assert.deepEqual(lateStars({ watch: [], day: "2026-07-14" }), []);
  assert.equal(lateStarsText(["COIN", "UBER"]), "Starred after the open: COIN, UBER");
  assert.equal(lateStarsText([]), null);
});

const session = <S extends "active" | "ended">(id: number, symbol: string, status: S) => ({ id, symbol, status, revealed_through: "2026-07-14T14:00:00Z", behind_clock: false, has_open_trade: false, trades: 0, realized_usd: 0, position: null });

test("Start Day opens on a focus name or a hold; a day under way resumes its open session; nothing to open on disables Start", () => {
  assert.deepEqual(boardStart(swingDayList), { kind: "start", symbol: "NVDA" });
  assert.deepEqual(boardStart({ ...swingDayList, watch: [] }), { kind: "start", symbol: "NVDA" }, "no star: the first hold");
  assert.deepEqual(boardStart({ ...swingDayList, watch: [], holds: [] }), { kind: "none" });
  const sessions = [session(90, "AMD", "active"), session(91, "NVDA", "active")];
  assert.deepEqual(boardStart({ ...swingDayList, status: "practicing", sessions }), { kind: "resume", symbol: "NVDA" }, "the first focus name's session");
  assert.deepEqual(boardStart({ ...swingDayList, status: "practicing", sessions: [sessions[0]!] }), { kind: "resume", symbol: "AMD" }, "else any open one");
  assert.deepEqual(boardStart({ ...swingDayList, status: "practicing", sessions: [session(90, "NVDA", "ended")] }), { kind: "start", symbol: "NVDA" });
  assert.equal(resumeDayLabel(7), "Resume Day 7");
});

test("Pass is offered only on a day she has not opened", () => {
  assert.equal(canPass(swingDayList), true);
  assert.equal(canPass({ status: "practicing", sessions: [] }), false);
  assert.equal(canPass({ status: "listed", sessions: [session(1, "NVDA", "active")] }), false);
  assert.equal(canPass({ status: "ended", sessions: [] }), false);
});

test("an ended day links its week, says when the review is ready, and offers the next day only when the calendar goes on", () => {
  const day7 = { day_no: 7, of: 20, week_no: 2 };
  const loading = endedDayView(day7, undefined);
  assert.deepEqual([loading.next, loading.notice, loading.reviewLabel, loading.reviewWeekNo], [null, null, "Open Week 2 review", 2]);

  const next = endedDayView(day7, { ...swingState, day_no: 8, days_ended: 7, week_no: 2, next: "day" });
  assert.deepEqual(next.next, { kind: "continue", label: "Continue Day 8" });
  assert.equal(next.notice, null);

  const lastOfWeek = endedDayView({ day_no: 5, of: 20, week_no: 1 }, { ...swingState, day_no: 6, days_ended: 5, week_no: 2, next: "week_review" });
  assert.equal(lastOfWeek.notice, "Week 1 is done. Review it to unlock Day 6.", "D-085: says why the next day waits");
  assert.deepEqual(lastOfWeek.next, { kind: "review" }, "the review comes before the next day");
  assert.equal(lastOfWeek.reviewLabel, "Open Week 1 review");

  assert.equal(lastOfWeek.waiting, null, "the day's own week is the one waiting: its link already goes there");

  // M6: an older ended day while the thread waits on Week 2's review still says so and links to it, beside its own week.
  const older = endedDayView({ day_no: 3, of: 20, week_no: 1 }, { ...swingState, day_no: 11, days_ended: 10, week_no: 3, next: "week_review" });
  assert.equal(older.notice, "Week 2 is done. Review it to unlock Day 11.");
  assert.deepEqual(older.waiting, { weekNo: 2, label: "Open Week 2 review" });
  assert.deepEqual([older.reviewLabel, older.reviewWeekNo], ["Open Week 1 review", 1]);
  assert.equal(next.waiting, null, "nothing waits when the next step is a day");

  const done = endedDayView({ day_no: 20, of: 20, week_no: 4 }, { ...swingState, day_no: 20, days_ended: 20, week_no: 4, next: "finished" });
  assert.deepEqual(done.next, { kind: "finished", text: "Thread finished · every hold closed at the last close" });

  assert.deepEqual(endedDayView(day7, null).next, { kind: "continue", label: "Continue Day 8" }, "state unreadable: the server decides");
  assert.equal(endedDayView({ day_no: 20, of: 20, week_no: 4 }, null).next?.kind, "finished");
});

test("the strings the board builds contain no banned word", () => {
  const built = [
    resumeDayLabel(7),
    lateStarsText(["COIN"])!,
    ...boardColumns(apiColumns).map((column) => column.label),
    endedDayView({ day_no: 5, of: 20, week_no: 1 }, { ...swingState, week_no: 2, next: "week_review" }).notice!,
  ];
  for (const text of built) assert.equal(containsPracticeBannedTerm(text), false, text);
});

test("right after Pass the board trusts no thread state until the refresh lands, so it never offers the day just passed (M1)", () => {
  const stale: SwingState = { ...swingState, day_no: 7, days_ended: 6, week_no: 2, next: "day" };
  const thread = (swing: SwingState | null) => ({ swing });
  assert.equal(trustedSwingState({ data: thread(stale), error: null, updating: true }), undefined, "refreshing: wait");
  assert.deepEqual(trustedSwingState({ data: thread(stale), error: null, updating: false }), stale);
  assert.equal(trustedSwingState({ data: null, error: null, updating: false }), undefined, "first load");
  assert.equal(trustedSwingState({ data: null, error: new Error("x"), updating: false }), null, "unreadable: the server decides");
  assert.equal(trustedSwingState({ data: thread(stale), error: new Error("x"), updating: false }), null, "a failed refresh leaves an answer older than the pass");
  assert.equal(trustedSwingState({ data: thread(null), error: null, updating: false }), null, "a thread without swing state");
  // What the board reads from it: nothing to continue to while it waits.
  assert.equal(endedDayView({ day_no: 7, of: 20, week_no: 2 }, trustedSwingState({ data: thread(stale), error: null, updating: true })).next, null);
});

test("waiting for the next day's data: open, back to the hub, keep asking, or give up after the preview's ten minutes (M3)", () => {
  const waiting = swingOpenNextWaiting;
  const t0 = 1_000;
  assert.deepEqual(prepStep(swingOpenNext, t0, t0), { kind: "open", href: "/practice/day?id=71" });
  assert.deepEqual(prepStep(waiting, t0, t0 + 3_000), { kind: "wait", prep: waiting.plan.prep });
  assert.deepEqual(prepStep(waiting, t0, t0 + PREVIEW_POLL_MAX_MS - 1), { kind: "wait", prep: waiting.plan.prep });
  assert.deepEqual(prepStep(waiting, t0, t0 + PREVIEW_POLL_MAX_MS), { kind: "expired" });
  assert.deepEqual(prepStep({ ...waiting, plan: { ...waiting.plan, finished: true } }, t0, t0), { kind: "hub" });
  assert.deepEqual(prepStep({ ...waiting, plan: { ...waiting.plan, prep: { ...waiting.plan.prep, state: "done" } } }, t0, t0), { kind: "hub" }, "nothing to wait for");
  assert.deepEqual(prepStep(swingOpenNext, t0, t0 + PREVIEW_POLL_MAX_MS * 2), { kind: "open", href: "/practice/day?id=71" }, "a day that opened beats the clock");
});
