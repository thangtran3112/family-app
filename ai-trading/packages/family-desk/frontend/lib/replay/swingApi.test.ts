import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { dayList } from "./dailyFixtures.ts";
import { delta, feed, markResult, openTrade, session } from "./fixtures.ts";
import {
  HoldSchema,
  MarkResultSchema,
  MarkUndoSchema,
  OpenTradeSchema,
  PausedSchema,
  ReplayDeltaSchema,
  ReplayFeedSchema,
  ReplaySessionSchema,
  StripRowSchema,
} from "./schemas.ts";
import {
  AnyDayListSchema,
  BoardRowSchema,
  continueSwingThread,
  endAnyDay,
  HoldsSchema,
  isSwingDayList,
  loadAnyDayList,
  loadHolds,
  loadWeek,
  loadWeeks,
  patchAnyDayList,
  patchWeek,
  previewSwingUniverse,
  SwingDayListSchema,
  SwingOpenNextSchema,
  UniversePreviewSchema,
  WeekSchema,
  WeeksSchema,
} from "./swingApi.ts";
import {
  amdHold,
  boardRows,
  closedHold,
  dailyBlock,
  holdsOut,
  nvdaHold,
  pausedCross,
  pausedGap,
  stripRows,
  swingBrief,
  swingDayList,
  swingDayListEnded,
  swingDelta,
  swingDeltaQuiet,
  swingFeed,
  swingOpenNext,
  swingOpenNextWaiting,
  swingOpenTrade,
  swingSession,
  swingThread,
  swingThreadSummary,
  universePreview,
  universePreviewPreparing,
  weekClosed,
  weeksOut,
  weekToDate,
} from "./swingFixtures.ts";
import { activeThread, thread as dayThread, threadBrief } from "./threadFixtures.ts";
import { ThreadBriefSchema, ThreadSchema, ThreadSummarySchema, ThreadsSchema } from "./threads.ts";

type Call = { method: string; path: string; body: unknown };

/** A client over a fake fetch: answers with `answer` and records each request. */
function fakeDesk(answer: unknown, status = 200) {
  const calls: Call[] = [];
  const client = createDeskApiClient(
    async (input, init) => {
      const url = input as URL;
      calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return Response.json(answer, { status });
    },
    () => ({ href: "https://trading.test/" }),
  );
  return { client, calls };
}

test("the swing day list parses, told from a day list by kind, whether listed or ended", () => {
  assert.equal(SwingDayListSchema.parse(swingDayList).holds.length, 2);
  assert.equal(SwingDayListSchema.parse(swingDayListEnded).journal?.entries, 1);
  const swing = AnyDayListSchema.parse(swingDayList);
  assert.equal(isSwingDayList(swing), true);
  const day = AnyDayListSchema.parse(dayList);
  assert.equal(isSwingDayList(day), false);
  assert.equal("kind" in day, false);
  if (isSwingDayList(swing)) assert.equal(swing.week_label, "Week 2");
});

test("a swing day list that is missing a field or names another kind does not parse", () => {
  assert.equal(AnyDayListSchema.safeParse({ ...swingDayList, label: undefined }).success, false);
  assert.equal(AnyDayListSchema.safeParse({ ...swingDayList, kind: "day" }).success, false);
  assert.equal(AnyDayListSchema.safeParse({ ...swingDayList, holds: [{ ...nvdaHold, stop_hit: true }] }).success, false, "no booleans on the wire");
  assert.equal(AnyDayListSchema.safeParse({ ...swingDayList, candidates: [{ ...boardRows[0], source: "mystery" }] }).success, false);
});

test("the board row, hold and strip schemas keep their nulls and reject a bad enum", () => {
  assert.equal(BoardRowSchema.parse(boardRows[3]).prior_close, null);
  assert.equal(HoldSchema.parse(closedHold).exit_source, "her");
  assert.equal(HoldSchema.safeParse({ ...nvdaHold, status: "paused" }).success, false);
  assert.equal(HoldSchema.safeParse({ ...nvdaHold, price_basis: "close" }).success, false);
  assert.equal(StripRowSchema.parse(stripRows[3]).last, null);
  assert.equal(StripRowSchema.safeParse({ ...stripRows[0], source: "watch" }).success, false);
  assert.equal(PausedSchema.parse(pausedGap).also.length, 2);
  assert.equal(PausedSchema.safeParse({ ...pausedCross, kind: "touch" }).success, false);
});

test("swing keys are optional on the shared responses, so a day session still parses and is left without them", () => {
  const plain = ReplayDeltaSchema.parse(delta);
  assert.deepEqual([plain.paused, plain.strip, plain.daily_forming], [undefined, undefined, undefined]);
  assert.equal(ReplayFeedSchema.parse(feed).daily, undefined);
  assert.equal(OpenTradeSchema.parse(openTrade).days_held, undefined);
  assert.equal(MarkResultSchema.parse(markResult).hold, undefined);
  assert.equal(ThreadBriefSchema.parse(threadBrief).equity_usd, undefined);
  assert.equal(ThreadSummarySchema.parse(activeThread).swing, undefined);
  assert.equal(ThreadSchema.parse(dayThread).swing, undefined);
  assert.equal(ReplaySessionSchema.parse(session).tape_feed, "sip");
});

test("a swing advance carries the pause, the strip and the forming candle; a quiet one has no pause key", () => {
  assert.equal(swingDelta.paused?.symbol, "AMD");
  assert.equal(swingDelta.strip?.length, 4);
  assert.equal(swingDelta.daily_forming?.t, "2026-07-14");
  assert.equal("paused" in swingDeltaQuiet, false);
  assert.equal(swingDeltaQuiet.strip?.[0]?.symbol, "NVDA");
  assert.equal(swingDelta.prints.feed, "off");
  assert.deepEqual(swingDelta.prints.rows, []);
  assert.equal(swingFeed.daily?.bars.length, 3);
  assert.equal(swingFeed.daily?.holds[0]?.stop_price, 178.5);
});

test("the open trade card of a swing hold: days held, the gap and the price basis, each optional", () => {
  assert.deepEqual(
    [swingOpenTrade.opened_day_no, swingOpenTrade.days_held, swingOpenTrade.gap_usd, swingOpenTrade.price_basis],
    [5, 3, 220, "last"],
  );
  const noGap = { ...openTrade, opened_day_no: 5, days_held: 1, price_basis: "prior_close" };
  assert.equal(OpenTradeSchema.parse(noGap).gap_usd, undefined, "no first price yet: the key is absent");
  assert.equal(OpenTradeSchema.parse({ ...noGap, gap_usd: null }).gap_usd, null);
});

test("a swing session, a mark with its hold and an undo with its hold parse", () => {
  const parsed = ReplaySessionSchema.parse(swingSession);
  assert.equal(parsed.tape_feed, "off");
  assert.equal(parsed.thread?.mode, "swing");
  assert.equal(parsed.open_trade?.days_held, 3);
  assert.equal(MarkResultSchema.parse({ ...markResult, hold: nvdaHold, thread: swingBrief }).hold?.symbol, "NVDA");
  assert.equal(MarkResultSchema.parse({ ...markResult, hold: null }).hold, null);
  assert.equal(MarkUndoSchema.parse({ removed_mark_id: 3, open_trade: null, journal: markResult.journal, thread: swingBrief, hold: amdHold }).hold?.side, "short");
  assert.equal(MarkUndoSchema.parse({ removed_mark_id: 3, open_trade: null, journal: markResult.journal, thread: null }).hold, undefined);
});

test("a swing thread carries its state and setup; the brief carries equity and free cash", () => {
  const summary = ThreadSummarySchema.parse(swingThreadSummary);
  assert.deepEqual([summary.swing?.day_no, summary.swing?.next, summary.swing?.holds_open], [7, "day", 2]);
  assert.equal(summary.thread.swing?.universe.length, 50);
  assert.equal(summary.thread.swing?.hideDates, "yes");
  assert.equal(ThreadsSchema.parse([summary, activeThread]).length, 2);
  assert.equal(ThreadSchema.parse(swingThread).swing?.equity_series.length, 6);
  const brief = ThreadBriefSchema.parse(swingBrief);
  assert.deepEqual([brief.equity_usd, brief.free_cash_usd, brief.day_no, brief.days, brief.week_no], [52010, 24720, 7, 20, 2]);
  assert.equal(ThreadSummarySchema.safeParse({ ...swingThreadSummary, swing: { ...swingThreadSummary.swing, next: "later" } }).success, false);
});

test("the preview, the open-next answers, the holds and the weeks parse", () => {
  assert.equal(UniversePreviewSchema.parse(universePreview).counts.total, 50);
  assert.equal(UniversePreviewSchema.parse(universePreviewPreparing).pending_symbols, 37);
  assert.equal(UniversePreviewSchema.safeParse({ ...universePreview, state: "waiting" }).success, false);
  assert.equal(SwingOpenNextSchema.parse(swingOpenNext).day_list_id, 71);
  assert.equal(SwingOpenNextSchema.parse(swingOpenNextWaiting).day_list_id, null);
  assert.equal(SwingOpenNextSchema.parse(swingOpenNextWaiting).plan.prep.state, "running");
  assert.equal(HoldsSchema.parse(holdsOut).holds.length, 3);
  assert.equal(HoldsSchema.parse({ ...holdsOut, as_of_day_no: null, holds: [] }).as_of_day_no, null);
  assert.equal(WeeksSchema.parse(weeksOut).weeks[1]?.realized_usd, null);
  const week = WeekSchema.parse(weekClosed);
  assert.deepEqual([week.status, week.to_date, week.review.holds.length, week.review.copy.length], ["closed", "no", 2, 1]);
  assert.equal(WeekSchema.parse(weekToDate).review.copy.length, 0);
  assert.equal(WeekSchema.safeParse({ ...weekClosed, to_date: true }).success, false);
  assert.equal(WeekSchema.safeParse({ ...weekClosed, review: { ...weekClosed.review, holds: [{ ...weekClosed.review.holds[0], stop: "crossed" }] } }).success, false);
});

test("the daily block is bars through the prior close plus a forming candle and the hold marker", () => {
  assert.equal(dailyBlock.bars.at(-1)?.t, "2026-07-13");
  assert.equal(dailyBlock.forming?.t, "2026-07-14");
});

// ---- loaders -------------------------------------------------------------------------------------------------------

test("the preview posts its body and starts nothing else; swing reads go through /api/desk/replay", async () => {
  const body = { first_day: "2026-07-20", sessions: 20, watchlist_ids: [3], filter_ids: [], fill: "liquidity" as const, add: ["NVDA"], remove: [], target: 50 };
  let d = fakeDesk(universePreview);
  assert.equal((await previewSwingUniverse(body, { client: d.client })).rows.length, 50);
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/threads/swing-universe", body });

  d = fakeDesk(swingOpenNext);
  assert.equal((await continueSwingThread(7, { client: d.client })).day_list_id, 71);
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/daily/next", body: { threadId: 7 } });
});

test("the day-list loaders answer a swing day or a day list", async () => {
  let d = fakeDesk(swingDayList);
  const swing = await loadAnyDayList(71, { peek: "NVDA" }, { client: d.client });
  assert.equal(isSwingDayList(swing), true);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/day-lists/71?peek=NVDA", body: undefined });

  d = fakeDesk(dayList);
  assert.equal(isSwingDayList(await loadAnyDayList(42, {}, { client: d.client })), false);
  assert.equal(d.calls[0]!.path, "/api/desk/replay/day-lists/42");

  d = fakeDesk(swingDayList);
  await patchAnyDayList(71, { watch: ["NVDA", "COIN"], notes: "gap day" }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/day-lists/71", body: { watch: ["NVDA", "COIN"], notes: "gap day" } });

  d = fakeDesk(swingDayListEnded);
  const ended = await endAnyDay(71, { client: d.client });
  assert.equal(ended.status, "ended");
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/replay/day-lists/71/end", body: {} });
});

test("holds default to all, weeks and one week read their paths, and the week patch sends only what changed", async () => {
  let d = fakeDesk(holdsOut);
  assert.equal((await loadHolds(7, "all", { client: d.client })).as_of_day_no, 6);
  assert.equal(d.calls[0]!.path, "/api/desk/replay/threads/7/holds?status=all");
  d = fakeDesk(holdsOut);
  await loadHolds(7, "open", { client: d.client });
  assert.equal(d.calls[0]!.path, "/api/desk/replay/threads/7/holds?status=open");

  d = fakeDesk(weeksOut);
  assert.equal((await loadWeeks(7, { client: d.client })).weeks.length, 2);
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/replay/threads/7/weeks", body: undefined });

  d = fakeDesk(weekClosed);
  assert.equal((await loadWeek(7, 1, { client: d.client })).label, "Week 1");
  assert.equal(d.calls[0]!.path, "/api/desk/replay/threads/7/weeks/1");

  d = fakeDesk(weekToDate);
  await patchWeek(7, 2, { rating: 4 }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PATCH", path: "/api/desk/replay/threads/7/weeks/2", body: { rating: 4 } });
  d = fakeDesk(weekToDate);
  await patchWeek(7, 2, { notes: null }, { client: d.client });
  assert.deepEqual(d.calls[0]!.body, { notes: null }, "null clears");
});

test("a malformed swing answer is a plain error, and a 404 week keeps its detail", async () => {
  await assert.rejects(loadWeek(7, 1, { client: fakeDesk({ ...weekClosed, status: "frozen" }).client }), (error) => error instanceof DeskApiError && error.kind === "malformed");
  await assert.rejects(
    loadWeek(7, 3, { client: fakeDesk({ detail: { problems: [{ path: "week", message: "Week 3 has not started yet" }] } }, 404).client }),
    (error) => error instanceof DeskApiError && error.status === 404 && error.problems[0]?.message === "Week 3 has not started yet",
  );
});
