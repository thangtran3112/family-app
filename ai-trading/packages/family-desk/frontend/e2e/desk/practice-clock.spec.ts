import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { formatDayResult } from "../../lib/replay/threadView.ts";
import { origin } from "../helpers";
import { nextOpenFromSummary } from "./clock-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { DAY, ET_OFFSET, REPLAY_URL, THREAD_URL, at, createThreadByApi, expectNoDayLanguage, get, jumpByApi, markByApi, openLaneByApi } from "./hub-helpers";

// The freestyle thread's clock lives on the server (ADR-0018, ADR-0025) and is real time, shifted: it keeps running when she leaves a chart for the
// Portfolio, closes the page or signs out; its whole board (Play or Pause, speed, Next open, Jump) is on the Summary and nowhere else, with no name
// opened first; it shows the full date and ticks each second; it does not stop, jump or change anything at the close, the night, the weekend or an
// open; and the account is priced at the clock. The stub holds TSLA on Fri 2026-09-25. Every step below is real wall time against the real server.

const readout = (page: Page) => page.getByTestId("thread-clock-time");

/** "Fri 2026-09-25 · 9:31:20 AM ET" to seconds since midnight. */
function seconds(text: string | null): number {
  const match = /(\d+):(\d+):(\d+)\s*(AM|PM)/.exec(text ?? "");
  if (!match) throw new Error(`not a clock: ${text}`);
  const hour = (Number(match[1]) % 12) + (match[4] === "PM" ? 12 : 0);
  return hour * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
const clockOf = async (page: Page) => seconds(await readout(page).textContent());

/** A thread started at 9:35 AM ET on the stub day, TSLA's lane open and its chart on screen. Returns the thread and the lane. */
async function startOnTsla(page: Page, context: BrowserContext): Promise<{ threadId: number; sessionId: number }> {
  const threadId = await createThreadByApi(context, { startAt: `${DAY}T09:35:00${ET_OFFSET}` });
  const sessionId = await openLaneByApi(context, threadId, "TSLA");
  await openDesk(page, `/practice/replay?id=${sessionId}`);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  return { threadId, sessionId };
}

const summaryUrl = (threadId: number) => `/practice/thread?id=${threadId}`;
const panel = (page: Page) => page.getByTestId("thread-clock");
const clockUrl = (threadId: number) => `${origin}/api/desk/replay/threads/${threadId}/clock`;

async function play(page: Page, speed: "1x" | "2x" | "5x" | "10x") {
  await panel(page).getByRole("button", { name: speed, exact: true }).click();
  await panel(page).getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("thread-clock-state")).toContainText(`Running at ${speed}`);
}

test.describe("Practice: the thread clock", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a chart has no transport, and the clock keeps running across chart, Portfolio, chart and a page that is closed", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { threadId, sessionId } = await startOnTsla(page, context);
    await markByApi(context, sessionId, { kind: "long_entry", shares: 100 }); // a position, so the Portfolio has a row to open the chart from

    // The chart: the thread's time and state as plain text, and nothing to press (no Play, Pause, Step, speed, Jump or timeline).
    const readoutLine = page.getByTestId("thread-time-readout");
    await expect(readoutLine).toContainText("Paused");
    for (const name of ["Play", "Pause", "Step"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Replay speed" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Jump/ })).toHaveCount(0);
    await expect(page.getByTestId("thread-clock")).toHaveCount(0);
    await expect(readoutLine.getByRole("link", { name: PRACTICE_COPY.chartClockLink })).toHaveAttribute("href", summaryUrl(threadId));
    await expectCleanScreen(page);

    // The Summary has them. Play at 5x.
    await page.getByRole("tab", { name: "Summary" }).click();
    await page.waitForURL(THREAD_URL);
    await expect(panel(page)).toBeVisible();
    await play(page, "5x");
    const started = await clockOf(page);

    // Portfolio, and back to the chart through the TSLA row: the clock did not stop, and nobody pressed Play again.
    await page.getByRole("tab", { name: "Portfolio" }).click();
    await page.waitForTimeout(3000);
    await page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle, exact: true }).getByRole("link", { name: "Open TSLA" }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(readoutLine).toHaveAttribute("data-running", "true");
    const onChart = await clockOf(page);
    expect(onChart, "the time moved while she was on the Portfolio").toBeGreaterThanOrEqual(started + 8);
    for (const name of ["Play", "Pause"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(await clockOf(page), "and it keeps moving on the chart").toBeGreaterThanOrEqual(onChart + 8);

    // She closes the page: the server clock does not care. Back on the Summary after the wait, it is further on and still running.
    const leftAt = await clockOf(page);
    await openDesk(page, "/practice");
    await page.waitForTimeout(4000);
    await openDesk(page, summaryUrl(threadId));
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId("thread-clock-state")).toContainText("Running at 5x");
    expect(await clockOf(page), "four seconds away is twenty market seconds at 5x").toBeGreaterThanOrEqual(leftAt + 15);

    // Pause holds it where it is.
    await panel(page).getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("thread-clock-state")).toContainText("Paused");
    const held = await clockOf(page);
    await page.waitForTimeout(3000);
    expect(await clockOf(page)).toBe(held);
    await expectCleanScreen(page);
  });

  test("the board is on the Summary before any name is opened: the clock plays with the Screen untouched and shows the full date, ticking", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createThreadByApi(context);
    await openDesk(page, summaryUrl(threadId));
    await expect(panel(page)).toBeVisible();
    for (const name of ["Play", "1x", "2x", "5x", "10x"]) await expect(panel(page).getByRole("button", { name, exact: true })).toBeEnabled();
    await expect(page.getByTestId("thread-clock-next-open"), "Next open is a chip beside the speeds").toBeEnabled();
    await expect(panel(page).getByRole("button", { name: PRACTICE_COPY.clockJumpGo, exact: true }), "Jump waits for a date and a time").toBeDisabled();
    for (const gone of ["Step", "Skip day", "End day"]) await expect(panel(page).getByRole("button", { name: gone, exact: true })).toHaveCount(0); // only Pause, the speed, Next open and Jump change time
    await expect(readout(page)).toHaveText(/^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} · \d{1,2}:\d{2}:\d{2} (AM|PM) ET$/); // the one format: weekday, ISO date, time to the second, zone
    const paused = await clockOf(page);

    await play(page, "5x");
    const first = await clockOf(page);
    await page.waitForTimeout(2500);
    expect(await clockOf(page), "the label ticks live between polls, at 5x").toBeGreaterThanOrEqual(first + 8);
    expect(first).toBeGreaterThanOrEqual(paused);
    const body = await (await context.request.get(clockUrl(threadId))).json();
    expect(body.state).toBe("running");
    expect(body.next_open, "the next open is the server's").not.toBeNull();
    expect(body.horizon).toBeTruthy();
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("the account is priced at the clock: equity moves with an open position while time runs and nobody is on the chart", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { threadId, sessionId } = await startOnTsla(page, context);
    await markByApi(context, sessionId, { kind: "long_entry", shares: 100 }); // a long in TSLA

    await openDesk(page, summaryUrl(threadId));
    const account = page.getByTestId("thread-clock-account");
    await expect(account).toBeVisible();
    // The big figure on the page is the equity, not only the realized balance.
    const equity = page.getByTestId("thread-balance");
    const first = await equity.textContent();
    await expect(page.getByTestId("thread-clock-buying-power")).toBeVisible();
    // D-170: a position is open, so the line under the headline says what is realized and the open P/L, never "no change yet".
    const place = page.getByRole("region", { name: "Thread balance" });
    await expect(place).toContainText(/Started with \$[\d,]+ · realized .* · open P\/L /);
    await expect(place).not.toContainText("no change yet");
    await expect(place.getByTestId("thread-since-start")).toBeVisible(); // equity less the starting balance: the day-free measure
    await expect(place).not.toContainText(/day p\/l|today/i);

    await play(page, "5x");
    await page.getByRole("tab", { name: "Portfolio" }).click(); // away from the Summary's numbers; the server keeps pricing
    await page.waitForTimeout(6000);
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect.poll(async () => equity.textContent(), { timeout: 30_000, message: "equity moved with the market" }).not.toBe(first);

    // The same account from the API, with the clock it is priced at: equity is the ledger balance plus the open P/L.
    await panel(page).getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("thread-clock-state")).toContainText("Paused");
    const body = await (await context.request.get(clockUrl(threadId))).json();
    expect(body.account.positions).toBe(1);
    expect(Math.abs(body.account.equity_usd - (body.account.balance + body.account.open_pnl_usd))).toBeLessThan(0.011);
    expect(Date.parse(body.account.as_of)).toBe(Date.parse(body.clock));
    expect(Date.parse(body.clock)).toBeGreaterThan(Date.parse(body.start_at));
    expect(Date.parse(body.clock)).toBeLessThanOrEqual(Date.parse(body.horizon)); // never past the horizon: nothing later is read
    // One open P/L on the Summary: the headline's line is the account's figure at the clock it stopped at.
    await expect(page.getByTestId("thread-balance-open")).toContainText(formatDayResult(body.account.open_pnl_usd), { timeout: 15_000 });
  });

  // ADR-0022: the date is never hidden. The chart's readout, the chip and the Summary clock all name the thread's own date; the Next open chip does too.
  test("the chart and the Summary clock show the date, and so does the Next open chip (ADR-0022)", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { threadId } = await startOnTsla(page, context);
    await expect(readout(page), "the chart's readout carries the date").toContainText("Fri 2026-09-25");
    await expect(page.getByRole("button", { name: /show date/i })).toHaveCount(0);
    await openDesk(page, summaryUrl(threadId));
    await expect(readout(page), "the clock shows the date from the first read").toContainText("Fri 2026-09-25");
    const chip = page.getByTestId("thread-clock-next-open");
    await expect(chip).toContainText(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 20\d\d-\d\d-\d\d/);
    await expect(chip, "the next open, never the setup's start").toContainText(/ 9:30 AM ET/);
  });

  test("nothing happens at the close, the night or the open: the clock flows through them and the position waits, open, until she trades it", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { threadId, sessionId } = await startOnTsla(page, context);
    await markByApi(context, sessionId, { kind: "long_entry", shares: 100 });
    await openDesk(page, summaryUrl(threadId));
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId("thread-clock-stays")).toHaveText(PRACTICE_COPY.clockNextOpenStaysOne);

    // The tape is the extended session (8:00 PM ET); the clock has no mark on its track and no "practice window".
    await expect(page.getByTestId("thread-clock-focus")).toHaveCount(0);
    await expect(panel(page)).not.toContainText(/practice window/i);
    const positions = async () => (await get(context, `/threads/${threadId}/clock`)).account.positions;
    const fills = async () => (await get(context, `/threads/${threadId}/fills`)).fills.map((fill: { action: string; source: string }) => [fill.action, fill.source]);

    // 5:05 PM ET, past the 4:00 close: nothing rolled, nothing stopped, nothing to press.
    await jumpByApi(context, threadId, at(DAY, "17:05"));
    await expect(readout(page)).toContainText(/Fri 2026-09-25 · 5:0\d:\d{2} PM ET/, { timeout: 15_000 });
    expect(await positions()).toBe(1);
    // The night after the tape ended, on the weekend: the clock still has a full date and time.
    await jumpByApi(context, threadId, at("2026-09-26", "01:05"));
    await expect(readout(page)).toContainText(/Sat 2026-09-26 · 1:0\d:\d{2} AM ET/, { timeout: 15_000 });
    await expect(page.getByTestId("thread-clock-rolled")).toHaveCount(0);
    await expect(page.getByText(/reached the close|reached the next session/)).toHaveCount(0);
    expect(await positions()).toBe(1); // the position waits, open

    // Next open: the clock crosses Monday's open. Nothing is handed over: the position is the same one, no exit was booked, the ledger is unchanged.
    const crossed = await nextOpenFromSummary(page);
    expect(Date.parse(crossed.clock)).toBe(Date.parse("2026-09-28T13:30:00Z"));
    await expect(readout(page)).toContainText(/Mon 2026-09-28 · 9:3\d:\d{2} AM ET/, { timeout: 15_000 });
    expect(await positions()).toBe(1);
    expect(await fills(), "one buy of hers; no auto exit anywhere").toEqual([["buy", "her"]]);
    expect((await get(context, `/threads/${threadId}/ledger`)).total, "nothing was realized").toBe(0);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("Next open with a position open says the position stays, goes to the next open and keeps the position priced at the new time", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { threadId, sessionId } = await startOnTsla(page, context);
    await markByApi(context, sessionId, { kind: "long_entry", shares: 100 });
    await openDesk(page, summaryUrl(threadId));
    await expect(page.getByTestId("thread-clock-stays")).toContainText("1 open position stays open and is priced at the new time");
    const before = await (await context.request.get(clockUrl(threadId))).json();

    await nextOpenFromSummary(page);
    await expect(readout(page)).toContainText(/Mon 2026-09-28 · 9:3\d:\d{2} AM ET/, { timeout: 15_000 });
    // D-218: the place line's "At" is the time the equity is priced at, so it moves with the figure, not stays on the clock the page loaded.
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(/At Mon 2026-09-28 · 9:3\d AM ET · 1 open position/, { timeout: 15_000 });
    // No look-ahead and no day: the position is the same shares at the same average cost, and the account is priced at the new clock.
    const after = await (await context.request.get(clockUrl(threadId))).json();
    expect(after.account.positions).toBe(1);
    expect(Date.parse(after.account.as_of)).toBe(Date.parse(after.clock));
    expect(Date.parse(after.clock)).toBeGreaterThan(Date.parse(before.clock));
    const portfolio = await get(context, `/threads/${threadId}/portfolio`);
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]).toMatchObject({ symbol: "TSLA", shares: 100, side: "long" });
    expect(Date.parse(portfolio.as_of)).toBe(Date.parse(after.clock));
    await expect(page.getByTestId("thread-clock-state")).toHaveText(PRACTICE_COPY.clockStatePaused);
    await expectNoDayLanguage(page);
  });

  test("a closed thread: the clock has stopped, the Summary shows no board and closing sold nothing", async ({ page, context }) => {
    test.setTimeout(180_000);
    const { threadId, sessionId } = await startOnTsla(page, context);
    await markByApi(context, sessionId, { kind: "long_entry", shares: 100 });
    expect((await context.request.post(`${origin}/api/desk/replay/threads/${threadId}/close`)).ok()).toBeTruthy();
    const stopped = await (await context.request.get(clockUrl(threadId))).json();
    expect(stopped.running).toBe(false);
    await openDesk(page, summaryUrl(threadId));
    await expect(page.getByTestId("thread-clock")).toHaveCount(0);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.overviewStepTitle })).toContainText(PRACTICE_COPY.overviewStepClosed);
    await expect(page.getByTestId("thread-balance")).toBeVisible();
    const thread = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}`)).json();
    expect(thread.positions_open, "closing sells nothing").toBe(1);
  });
});
