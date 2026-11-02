import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { THREAD_URL, openFirstDay, startThread } from "./hub-helpers";
import { placeOrder } from "./swing-helpers";

// The day thread's clock lives on the server (ADR-0018): it keeps running when she leaves a chart for the Portfolio, closes the
// page or signs out; its controls are on the Summary and nowhere else; Skip day runs it to the close and opens the next day; and
// the account is priced at the clock. The stub holds TSLA on Fri 2026-09-25, replayed 09:30 to 09:40 ET: ten market minutes, so
// at 5x the whole window is two wall minutes. Every step below is real wall time against the real server.

const SESSION_URL = /\/practice\/replay\?id=\d+/;
const readout = (page: Page) => page.getByTestId("thread-clock-time");

/** "9:31:20 AM ET" to seconds since midnight. */
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

  test("Skip day runs to the close, closes the position at it and opens the next day", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startDayOnTsla(page, context);
    await placeOrder(page, "Buy");
    await page.getByRole("tab", { name: "Summary" }).click();
    await page.waitForURL(THREAD_URL);

    await panel(page).getByRole("button", { name: PRACTICE_COPY.clockSkipDay, exact: true }).click();
    await panel(page).getByRole("button", { name: PRACTICE_COPY.clockSkipConfirm, exact: true }).click();
    await expect(panel(page).getByText(/^Skipped/)).toBeVisible({ timeout: 90_000 });

    // Day 1 ended with its trade booked, and Day 2 is the open day: not started, so nothing runs yet.
    await expect(page.getByRole("link", { name: /^Open Day 2$/ }).or(page.getByRole("button", { name: /^Start Day 2$/ }))).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("thread-clock-state")).toContainText(PRACTICE_COPY.clockStateListed);
    const days = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}`)).json();
    expect(days.daily).toHaveLength(1);
    expect(days.daily[0].kind).toBe("practiced");
    expect(days.daily[0].trades).toBe(1);
    const fills = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/fills`)).json();
    expect(fills.fills.map((f: { action: string; source: string }) => [f.action, f.source])).toEqual([["sell", "auto"], ["buy", "her"]]); // the close, then the buy
    await expectCleanScreen(page);
  });
});
