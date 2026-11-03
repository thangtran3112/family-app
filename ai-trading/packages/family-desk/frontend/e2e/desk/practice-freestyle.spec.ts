import type { BrowserContext, Page } from "@playwright/test";
import { formatPrice } from "../../lib/desk/format.ts";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { formatSignedUsd } from "../../lib/desk/mask.ts";
import { heldForText } from "../../lib/replay/positionTable.ts";
import { jumpFromSummary, nextOpenFromSummary } from "./clock-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { DAY, ET_OFFSET, at, createThreadByApi, expectNoDayLanguage, get, jumpByApi, markByApi, openLaneByApi, scanByApi, send, type Json } from "./hub-helpers";
import { positionCells } from "./position-table";

// The owner's bug and its fix (ADR-0025): a position she forgot to exit used to be sold at the tape's end and booked when a Jump crossed an open. A freestyle
// thread keeps it. She buys TSLA, jumps days ahead, and the Portfolio shows the same shares at the same average cost, priced at the NEW time; Next open keeps it
// too; nothing in Practice ends, skips or hands over a day. The stub holds bars for Fri 2026-09-25 only (backend/src/ai_trading/replay/fixture.py): a Jump past
// that day is allowed up to the horizon, and a name with no print after the fixture is carried at its last print, so the specs assert what must hold (the same
// position, one price function, the gain or loss it implies, the ledger untouched) and not a particular price on a later date.

const summaryUrl = (threadId: number) => `/practice/thread?id=${threadId}`;
const portfolioUrl = (threadId: number) => `${summaryUrl(threadId)}&tab=portfolio`;
const portfolioRegion = (page: Page) => page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle, exact: true });

/** A thread started at 9:35 AM ET on the stub day with a long of 100 TSLA bought at that time. */
async function holdTsla(context: BrowserContext): Promise<{ threadId: number; sessionId: number }> {
  const threadId = await createThreadByApi(context, { startAt: `${DAY}T09:35:00${ET_OFFSET}` });
  await scanByApi(context, threadId);
  const sessionId = await openLaneByApi(context, threadId, "TSLA");
  await markByApi(context, sessionId, { kind: "long_entry", shares: 100 });
  return { threadId, sessionId };
}

/** The Portfolio tab's TSLA row against the server's portfolio at the clock: shares, average cost, the price at T and the gain or loss they imply. */
async function expectRowIsThePortfolio(page: Page, portfolio: Json) {
  const [held] = portfolio.positions as Json[];
  const region = portfolioRegion(page);
  await expect(region.getByTestId("portfolio-count")).toHaveText(PRACTICE_COPY.threadPositionsOne);
  const cells = await positionCells(region, "TSLA");
  expect(cells["Shares"]).toBe("100");
  expect(cells["Avg cost"]).toBe(formatPrice(held.avg_cost));
  expect(cells["Price at thread time"], "the price at the thread's time").toContain(formatPrice(held.price));
  expect(cells["Gain/loss"], "gain or loss is the price at T against the average cost").toBe(formatSignedUsd(held.unrealized_usd, { cents: true }));
  if ("Held for" in cells) expect(cells["Held for"]).toBe(heldForText(held.held_for_s));
}

/** Gain or loss to the cent, from the portfolio's own figures. */
const expectedGain = (held: Json) => Math.round((held.price - held.avg_cost) * held.shares * (held.side === "short" ? -1 : 1) * 100) / 100;

test.describe("Practice: a freestyle thread keeps what she holds", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a long held across a Jump of days keeps its shares and cost, is priced at the new time, and Next open keeps it too; nothing is sold or booked", async ({ page, context }) => {
    test.setTimeout(420_000);
    const { threadId, sessionId } = await holdTsla(context);
    const book = () => get(context, `/threads/${threadId}/portfolio`);
    const first = await book();
    expect(first.positions).toHaveLength(1);
    const held = first.positions[0] as Json;
    expect(held).toMatchObject({ symbol: "TSLA", side: "long", shares: 100, session_id: sessionId });
    expect(Date.parse(first.as_of)).toBe(Date.parse(`${DAY}T13:35:00Z`)); // priced at the thread's start
    const ledger = async () => (await get(context, `/threads/${threadId}/ledger`)).total as number;
    const fills = async () => ((await get(context, `/threads/${threadId}/fills`)).fills as Json[]).map((fill) => [fill.action, fill.source]);
    expect(await ledger()).toBe(0);

    // The Portfolio tab: one row, in the columns of ADR-0025 (Ticker, Side, Shares, Avg cost, Price at thread time, Gain/loss, Held for, Working orders).
    await openDesk(page, portfolioUrl(threadId));
    const region = portfolioRegion(page);
    for (const name of ["Ticker", "Shares", "Avg cost", "Price at thread time", "Gain/loss"]) await expect(region.getByRole("columnheader", { name, exact: true })).toBeVisible();
    for (const gone of ["Last", "Change", "Change %", "Position", "Value", "Days held"]) await expect(region.getByRole("columnheader", { name: gone, exact: true })).toHaveCount(0);
    await expectRowIsThePortfolio(page, first);

    // Jump forward the same day through the Summary's form: the same position, priced at 11:00 AM.
    await openDesk(page, summaryUrl(threadId));
    await expect(page.getByTestId("thread-clock-stays")).toHaveText(PRACTICE_COPY.clockNextOpenStaysOne);
    await jumpFromSummary(page, DAY, "11:00");
    await expect(page.getByTestId("thread-clock-time")).toHaveText(/^Fri 2026-09-25 · 11:00:\d{2} AM ET$/, { timeout: 15_000 });
    const sameDay = await book();
    expect(Date.parse(sameDay.as_of)).toBe(Date.parse(`${DAY}T15:00:00Z`));
    expect(sameDay.positions).toHaveLength(1);
    expect(sameDay.positions[0]).toMatchObject({ symbol: "TSLA", side: "long", shares: 100, avg_cost: held.avg_cost });
    expect(sameDay.positions[0].unrealized_usd).toBeCloseTo(expectedGain(sameDay.positions[0]), 2);
    expect(sameDay.positions[0].held_for_s, "held for the elapsed thread time since the entry: 9:35 to 11:00").toBeGreaterThanOrEqual(85 * 60 - 60);
    await openDesk(page, portfolioUrl(threadId));
    await expectRowIsThePortfolio(page, sameDay);

    // Jump a week ahead, across a weekend and four market opens. Nothing closed at any of them: the first read prices the holding at the new time.
    await openDesk(page, summaryUrl(threadId));
    await jumpFromSummary(page, "2026-10-02", "10:00");
    await expect(page.getByTestId("thread-clock-time")).toHaveText(/^Fri 2026-10-02 · 10:00:\d{2} AM ET$/, { timeout: 30_000 });
    const later = await book();
    expect(Date.parse(later.as_of)).toBe(Date.parse("2026-10-02T14:00:00Z"));
    expect(later.positions, "the position survived the opens, the weekend and the close").toHaveLength(1);
    const kept = later.positions[0] as Json;
    expect(kept).toMatchObject({ symbol: "TSLA", side: "long", shares: 100, avg_cost: held.avg_cost, session_id: sessionId });
    expect(kept.unrealized_usd, "gain or loss = (price at T - average cost) x shares, to the cent").toBeCloseTo(expectedGain(kept), 2);
    const week = Date.parse("2026-10-02T14:00:00Z") / 1000 - Date.parse(held.entry_at) / 1000;
    expect(Math.abs(kept.held_for_s - week), "held for seven days and a little: calendar time, not trading days").toBeLessThan(120);
    await openDesk(page, portfolioUrl(threadId));
    await expectRowIsThePortfolio(page, later);
    expect(await ledger(), "nothing was sold or booked by the Jump").toBe(0);
    expect(await fills(), "one buy of hers, no auto exit").toEqual([["buy", "her"]]);

    // Next open from the Summary keeps it too: Friday 10:00 AM goes to Monday's 9:30 AM open.
    await openDesk(page, summaryUrl(threadId));
    await expect(page.getByTestId("thread-clock-stays")).toBeVisible();
    const crossed = await nextOpenFromSummary(page);
    expect(Date.parse(crossed.clock)).toBe(Date.parse("2026-10-05T13:30:00Z"));
    await expect(page.getByTestId("thread-clock-time")).toHaveText(/^Mon 2026-10-05 · 9:30:\d{2} AM ET$/, { timeout: 15_000 });
    const monday = await book();
    expect(monday.positions).toHaveLength(1);
    expect(monday.positions[0]).toMatchObject({ symbol: "TSLA", side: "long", shares: 100, avg_cost: held.avg_cost });
    expect(Date.parse(monday.as_of)).toBe(Date.parse("2026-10-05T13:30:00Z"));
    expect(await ledger()).toBe(0);
    expect(await fills()).toEqual([["buy", "her"]]);
    // The Summary counts it as open and the headline is equity, not the realized balance.
    await expect(page.getByTestId("thread-balance-open")).toBeVisible();
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(PRACTICE_COPY.threadPositionsOne);
    await expectNoDayLanguage(page);
  });

  test("no screen of the thread speaks of a day that ends, is skipped or is handed over: Summary, Portfolio, Screen, chart and journal, with a position open", async ({ page, context }) => {
    test.setTimeout(300_000);
    const { threadId, sessionId } = await holdTsla(context);
    // The chart needs bars for the data day the clock stands on, and the stub holds them for the stub day only: the chart is read at 11:00 that day.
    await jumpByApi(context, threadId, at(DAY, "11:00"));
    const everyScreen = [summaryUrl(threadId), portfolioUrl(threadId), `/practice/screen?thread=${threadId}`, `/practice/replay?id=${sessionId}`, `/practice/journal?thread=${threadId}`];
    const noDayLanguage = async (paths: string[]) => {
      for (const path of paths) {
        await openDesk(page, path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectNoDayLanguage(page);
        await expect(page.getByRole("button", { name: /end day|skip day/i }), path).toHaveCount(0);
        await expect(page.getByRole("link", { name: /end day|skip day|swing|start day|week review/i }), path).toHaveCount(0);
        await expectCleanScreen(page);
      }
    };
    await noDayLanguage(everyScreen);

    // Days later, past a weekend and four opens: every screen that reads the book still says nothing about a day (the chart has no bars for that day in the stub).
    await jumpByApi(context, threadId, at("2026-09-28", "10:00"));
    await noDayLanguage(everyScreen.filter((path) => !path.includes("/practice/replay")));

    // The Screen lists the name she holds, marked at T, and links to its lane; the journal says the position is open and not in the realized balance.
    await openDesk(page, `/practice/screen?thread=${threadId}`);
    await expect(page.getByTestId("screen-lanes")).toContainText("TSLA");
    await openDesk(page, `/practice/journal?thread=${threadId}`);
    await expect(page.getByTestId("journal-open-positions")).toContainText("1 open position");
    await expect(page.getByTestId("journal-open-positions").getByRole("link", { name: PRACTICE_COPY.journalOpenPortfolio })).toHaveAttribute("href", portfolioUrl(threadId));
  });

  test("a working order keeps its time in force across a Jump: GTC rests through the close and the weekend, Day lapses at the close of the session it was placed in", async ({ page, context }) => {
    test.setTimeout(300_000);
    const threadId = await createThreadByApi(context, { startAt: `${DAY}T09:35:00${ET_OFFSET}` });
    const sessionId = await openLaneByApi(context, threadId, "TSLA");
    // Two buy limits far below the market: they rest. GTC is the default; Day is the ticket's other choice.
    const gtc = await send(context, "POST", `/sessions/${sessionId}/orders`, { side: "buy", orderType: "limit", shares: 10, limitPrice: 50 });
    const day = await send(context, "POST", `/sessions/${sessionId}/orders`, { side: "buy", orderType: "limit", shares: 10, limitPrice: 40, timeInForce: "day" });
    expect(gtc.order).toMatchObject({ status: "working", tif: "gtc" });
    expect(day.order).toMatchObject({ status: "working", tif: "day" });
    expect(day.order.expires_at, "a Day order says when it lapses: the extended close of its session").toBeTruthy();

    // The Portfolio lists both under Working orders, with their time in force.
    await openDesk(page, portfolioUrl(threadId));
    const orders = portfolioRegion(page).getByRole("table", { name: PRACTICE_COPY.portfolioOrdersTitle });
    await expect(orders.getByRole("row", { name: /TSLA/ })).toHaveCount(2);
    await expect(orders).toContainText(PRACTICE_COPY.portfolioTifGtc);
    await expect(orders).toContainText(PRACTICE_COPY.portfolioTifDay);

    // Past the close and into the night: the Day order lapsed ("Expired"), the GTC order is still working. Nothing filled.
    await jumpByApi(context, threadId, at("2026-09-26", "01:00"));
    const lane = await get(context, `/sessions/${sessionId}`);
    const byTif = (tif: string) => (lane.orders as Json[]).find((order) => order.tif === tif);
    expect(byTif("day")).toMatchObject({ status: "cancelled", reason: "Expired" });
    expect(byTif("gtc")).toMatchObject({ status: "working" });
    await openDesk(page, portfolioUrl(threadId));
    await expect(portfolioRegion(page).getByRole("table", { name: PRACTICE_COPY.portfolioOrdersTitle }).getByRole("row", { name: /TSLA/ })).toHaveCount(1);
    await expect(portfolioRegion(page).getByRole("table", { name: PRACTICE_COPY.portfolioOrdersTitle })).not.toContainText(PRACTICE_COPY.portfolioTifDay);

    // Across the weekend and Monday's open: the GTC order is the same one.
    await jumpByApi(context, threadId, at("2026-09-28", "11:00"));
    // (the lane itself has no stub bars on a Monday; the Portfolio lists the working orders without them)
    const monday = await get(context, `/threads/${threadId}/portfolio`);
    expect((monday.orders as Json[]).find((order) => order.tif === "gtc")).toMatchObject({ status: "working", id: gtc.order.id });
    expect((monday.orders as Json[]).filter((order) => order.tif === "day")).toHaveLength(0);
    expect((await get(context, `/threads/${threadId}/fills`)).fills).toHaveLength(0);
    await expectNoDayLanguage(page);
  });
});
