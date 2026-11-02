import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { THREAD_URL, openFirstDay, startThread } from "./hub-helpers";
import { placeOrder } from "./swing-helpers";

// The day thread's clock lives on the server (ADR-0018) and is real time, shifted: it keeps running when she leaves a chart for the
// Portfolio, closes the page or signs out; its whole board (Play or Pause, speed, Skip day) is on the Summary and nowhere else, with
// no stock opened first; it shows the full date and ticks each second; it does not stop or jump at the close, the night or the weekend
// (the day hands over only when the clock reaches the next session's start); Skip day jumps to that start; and the account is priced at
// the clock. Her plan's window is a mark. The stub holds TSLA on Fri 2026-09-25, replayed 09:30 to 09:40 ET. Every step below is real
// wall time against the real server.

const SESSION_URL = /\/practice\/replay\?id=\d+/;
const readout = (page: Page) => page.getByTestId("thread-clock-time");

/** "Fri, Sep 25 · 9:31:20 AM ET" to seconds since midnight. */
function seconds(text: string | null): number {
  const match = /(\d+):(\d+):(\d+)\s*(AM|PM)/.exec(text ?? "");
  if (!match) throw new Error(`not a clock: ${text}`);
  const hour = (Number(match[1]) % 12) + (match[4] === "PM" ? 12 : 0);
  return hour * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
const clockOf = async (page: Page) => seconds(await readout(page).textContent());

/** A started day: a thread, its first day open, TSLA's chart on screen. Returns the thread id. */
async function startDayOnTsla(page: Page, context: Parameters<typeof startThread>[1]): Promise<number> {
  const threadId = await startThread(page, context);
  await openFirstDay(page);
  await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  return threadId;
}

const summaryUrl = (threadId: number) => `/practice/thread?id=${threadId}`;
const panel = (page: Page) => page.getByTestId("thread-clock");

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
    const threadId = await startDayOnTsla(page, context);

    // The chart: the thread's time and state as plain text, and nothing to press (no Play, Pause, Step, speed, Jump or timeline).
    const readoutLine = page.getByTestId("thread-time-readout");
    await expect(readoutLine).toContainText("Paused");
    for (const name of ["Play", "Pause", "Step"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Replay speed" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Jump/ })).toHaveCount(0);
    await expect(page.getByTestId("thread-clock")).toHaveCount(0);
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
    await page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true }).getByRole("button", { name: "Switch to TSLA" }).click();
    await page.waitForURL(SESSION_URL);
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

  test("the board is on the Summary before any stock is opened: the clock plays with the Day list untouched and shows the full date, ticking", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page); // the Day list: no stock opened, and none will be
    await openDesk(page, summaryUrl(threadId));
    await expect(panel(page)).toBeVisible();
    await expect(page.getByText(/Open a stock from the Day list/)).toHaveCount(0);
    for (const name of ["Play", "Skip day", "End day", "1x", "2x", "5x", "10x"]) await expect(panel(page).getByRole("button", { name, exact: true })).toBeEnabled();
    for (const name of ["Step"]) await expect(panel(page).getByRole("button", { name, exact: true })).toHaveCount(0); // only Pause, the speed and Skip day change time
    await expect(panel(page).getByRole("button", { name: /^Jump/ })).toHaveCount(0);
    await expect(readout(page)).toHaveText(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · \d{1,2}:\d{2}:\d{2} (AM|PM) ET$/); // a full date, never a bare time
    const paused = await clockOf(page);

    await play(page, "5x");
    const first = await clockOf(page);
    await page.waitForTimeout(2500);
    expect(await clockOf(page), "the label ticks live between polls, at 5x").toBeGreaterThanOrEqual(first + 8);
    expect(first).toBeGreaterThanOrEqual(paused);
    const body = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/clock`)).json();
    expect(body.state).toBe("running");
    expect(body.next_start).not.toBeNull();
    await expectCleanScreen(page);
  });

  test("the account is priced at the clock: equity moves with an open position while time runs and nobody is on the chart", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startDayOnTsla(page, context);
    await placeOrder(page, "Buy"); // a long in TSLA at the open
    await expect(page.getByRole("tab", { name: "Marks" })).toBeVisible();

    await page.getByRole("tab", { name: "Summary" }).click();
    await page.waitForURL(THREAD_URL);
    const account = page.getByTestId("thread-clock-account");
    await expect(account).toBeVisible();
    const equity = page.getByTestId("thread-clock-equity");
    const first = await equity.textContent();
    await expect(page.getByTestId("thread-balance"), "the big figure on the page is the equity, not only the realized balance").toHaveText(first ?? "");

    await play(page, "5x");
    await page.getByRole("tab", { name: "Portfolio" }).click(); // away from the Summary's numbers; the server keeps pricing
    await page.waitForTimeout(6000);
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect.poll(async () => equity.textContent(), { timeout: 30_000, message: "equity moved with the market" }).not.toBe(first);
    // The same account from the API, with the clock it is priced at: equity is the ledger balance plus the open P/L.
    const body = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/clock`)).json();
    expect(body.account.positions).toBe(1);
    expect(Math.abs(body.account.equity_usd - (body.account.balance + body.account.open_pnl_usd))).toBeLessThan(0.011);
    expect(Date.parse(body.account.as_of)).toBe(Date.parse(body.clock));
    expect(Date.parse(body.clock)).toBeGreaterThan(Date.parse(body.window_start));
    expect(Date.parse(body.clock)).toBeLessThanOrEqual(Date.parse(body.window_end)); // never past the window: nothing later is read
  });

  test("nothing happens at the close: the clock flows through after-hours and the night, and the day hands over only at the next session's start", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startDayOnTsla(page, context);
    await placeOrder(page, "Buy");
    await page.getByRole("tab", { name: "Summary" }).click();
    await page.waitForURL(THREAD_URL);

    // The plan's window ends long before the tape does: the track carries it as a mark. The tape is the extended session (8:00 PM ET).
    const clockUrl = `${origin}/api/desk/replay/threads/${threadId}/clock`;
    const before = await (await context.request.get(clockUrl)).json();
    expect(Date.parse(before.focus_end)).toBeLessThan(Date.parse(before.window_end));
    expect(new Date(before.window_end).toISOString()).toMatch(/T00:00:00\.000Z$/); // 8:00 PM ET
    await expect(page.getByTestId("thread-clock-focus")).toBeAttached();
    const jump = async (to: number) => {
      const response = await context.request.post(clockUrl, { data: { to: new Date(to).toISOString() } });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };

    // 5:00 PM ET, past the 4:00 close: still Day 1, nothing rolled, nothing stopped, nothing to press.
    const hour = 3_600_000;
    const afterHours = await jump(Date.parse(before.window_end) - 3 * hour);
    expect(afterHours.day_no).toBe(1);
    await expect(readout(page)).toContainText(/Sep 25 · 5:0\d:\d{2} PM ET/, { timeout: 15_000 });
    // The night after the tape ended: the same day, the clock still has a full date and time.
    const night = await jump(Date.parse(before.window_end) + 5 * hour);
    expect(night.day_no).toBe(1);
    await expect(readout(page)).toContainText(/Sep 26 · 1:0\d:\d{2} AM ET/, { timeout: 15_000 });
    await expect(page.getByTestId("thread-clock-rolled")).toHaveCount(0);
    await expect(page.getByText(/reached the close/)).toHaveCount(0);
    expect((await (await context.request.get(clockUrl)).json()).account.positions).toBe(1); // the position waits, open

    // The clock reaching the next session is the hand-over: Day 1 ends (the position books), Day 2 is listed, the clock carries on.
    const next = await jump(Date.parse(before.next_start));
    expect(next.day_no).toBe(2);
    await expect(page.getByTestId("thread-clock-rolled")).toContainText(/^The clock reached the next session\. Day 1 ended/, { timeout: 30_000 });
    await expect(readout(page)).toContainText(/ 9:3\d:\d{2} AM ET/);
    const fills = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/fills`)).json();
    expect(fills.fills.map((f: { action: string; source: string }) => [f.action, f.source])).toEqual([["sell", "auto"], ["buy", "her"]]);
    await expectCleanScreen(page);
  });

  test("Skip day jumps to the next session, closes the position at the last price of the day and opens the next day", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startDayOnTsla(page, context);
    await placeOrder(page, "Buy");
    await page.getByRole("tab", { name: "Summary" }).click();
    await page.waitForURL(THREAD_URL);

    await panel(page).getByRole("button", { name: PRACTICE_COPY.clockSkipDay, exact: true }).click();
    await panel(page).getByRole("button", { name: PRACTICE_COPY.clockSkipConfirm, exact: true }).click();
    await expect(panel(page).getByText(/^Skipped/)).toBeVisible({ timeout: 90_000 });

    // Day 1 ended with its trade booked, and Day 2 is the open day: its clock stands at the day's start, paused as the old one was.
    await expect(page.getByRole("link", { name: /^Open Day 2$/ }).or(page.getByRole("button", { name: /^Start Day 2$/ }))).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("thread-clock-state")).toContainText(PRACTICE_COPY.clockStatePaused);
    await expect(readout(page)).toContainText(/ 9:3\d:\d{2} AM ET/);
    const days = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}`)).json();
    expect(days.daily).toHaveLength(1);
    expect(days.daily[0].kind).toBe("practiced");
    expect(days.daily[0].trades).toBe(1);
    const fills = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/fills`)).json();
    expect(fills.fills.map((f: { action: string; source: string }) => [f.action, f.source])).toEqual([["sell", "auto"], ["buy", "her"]]); // the close, then the buy
    await expectCleanScreen(page);
  });
});
