import type { BrowserContext, Page } from "@playwright/test";
import { formatPrice } from "../../lib/desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { DAY_URL, THREAD_URL, createThreadByApi, openFirstDay, startThread } from "./hub-helpers";

// One thread time (ADR-0022). The thread's clock is the server's; every screen of the thread reads the time of its own payload and shows it in the
// one format, and a screen that stops being updated says so. The stub day is TSLA on Fri 2026-09-25 with bars until 09:40 ET; the tape of a
// day thread runs to 8:00 PM ET, and the clock goes on through the night.

const SESSION_URL = /\/practice\/replay\?id=\d+/;
const readout = (page: Page) => page.getByTestId("thread-clock-time");

/** A started day on the Day list, with the thread's clock url. */
async function startDay(page: Page, context: BrowserContext): Promise<{ threadId: number; clockUrl: string }> {
  const threadId = await startThread(page, context);
  await openFirstDay(page);
  return { threadId, clockUrl: `${origin}/api/desk/replay/threads/${threadId}/clock` };
}

/** TSLA's chart from the Day list. Returns the session id. */
async function openTsla(page: Page): Promise<number> {
  await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  return Number(/id=(\d+)/.exec(page.url())![1]);
}

test.describe("Practice: one thread time", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("overnight at 1:22 AM the Summary, the chart and the Day list show the same date and time, and the price stands still with the market closed", async ({ page, context }) => {
    test.setTimeout(300_000);
    const { clockUrl } = await startDay(page, context);
    const dayUrl = page.url();
    const sessionId = await openTsla(page);
    const chartPath = new URL(page.url()).pathname + new URL(page.url()).search;

    // The clock is paused (nobody pressed Play), so every screen reads exactly the instant we set: Saturday 1:22:24 AM ET, five hours and 22 minutes past
    // the 8:00 PM end of the tape.
    const before = await (await context.request.get(clockUrl)).json();
    const target = new Date(Date.parse(before.window_end) + (5 * 3600 + 22 * 60 + 24) * 1000).toISOString();
    const moved = await context.request.post(clockUrl, { data: { to: target } });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    const WHEN = "Sat 2026-09-26 · 1:22:24 AM ET";

    // The server's payloads say the same thing: T is the clock, the data stops at the tape end, the market is closed (I1).
    const feed = await (await context.request.get(`${origin}/api/desk/replay/sessions/${sessionId}/feed`)).json();
    expect(Date.parse(feed.thread_time)).toBe(Date.parse(target));
    expect(Date.parse(feed.data_through)).toBe(Date.parse(before.window_end));
    expect(feed.market.phase).toBe("closed");

    // The Summary.
    await page.getByRole("tab", { name: PRACTICE_COPY.tabSummary }).click();
    await page.waitForURL(THREAD_URL);
    await expect(readout(page)).toHaveText(WHEN);
    await expect(page.getByText(/hidden day|show date|replayed market date/i)).toHaveCount(0);

    // The chart (a name's chart opens at the clock): the same date and time in the readout, the top-bar chip and the status bar, the closed
    // market beside the still-counting time, and a price that is the last print and does not move.
    await openDesk(page, chartPath);
    await expect(readout(page)).toHaveText(WHEN);
    await expect(page.getByText(`Replay · ${WHEN}`)).toBeVisible();
    await expect(page.getByLabel("Status")).toContainText("Replay clock");
    await expect(page.getByTestId("market-closed")).toHaveText("Market closed · data through 8:00 PM ET");
    const price = page.locator("dt", { hasText: "Last price" }).locator("xpath=following-sibling::dd");
    await expect(price).toHaveText(formatPrice(feed.last.price));
    await page.waitForTimeout(5000); // two sync polls later
    await expect(price, "closed: the price is frozen at the last print").toHaveText(formatPrice(feed.last.price));
    await expect(readout(page)).toHaveText(WHEN);
    await expect(page.getByTestId("chart-stale")).toHaveCount(0);
    const again = await (await context.request.get(`${origin}/api/desk/replay/sessions/${sessionId}/feed`)).json();
    expect(again.last, "a read moves nothing (I5)").toEqual(feed.last);
    await expectCleanScreen(page);

    // The Day list: the same time, the market closed, and each name priced at the same last print as the chart.
    await openDesk(page, dayUrl.replace(origin, ""));
    await page.waitForURL(DAY_URL);
    await expect(page.getByTestId("day-clock-time")).toHaveText(WHEN);
    await expect(page.getByTestId("market-closed")).toContainText("Market closed · data through 8:00 PM ET");
    const dayId = Number(/id=(\d+)/.exec(dayUrl)![1]);
    const list = await (await context.request.get(`${origin}/api/desk/replay/day-lists/${dayId}?live=true`)).json();
    expect(Date.parse(list.thread_time)).toBe(Date.parse(target));
    expect(list.market.phase).toBe("closed");
    expect(list.candidates.find((row: { symbol: string }) => row.symbol === "TSLA").live.price, "one price function: the Day list prices TSLA as the chart does").toBe(feed.last.price);
    await expect(page.getByText(`Replay · ${WHEN}`)).toBeVisible();
    await expectCleanScreen(page);
  });

  test("a chart whose sync polls fail freezes its readout, dims, and says it is not updating; it recovers on the next answer", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startDay(page, context);
    await openTsla(page);
    const frozen = (await readout(page).textContent()) ?? "";
    expect(frozen).toMatch(/^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} · \d{1,2}:\d{2}:\d{2} (AM|PM) ET$/);
    await expect(page.getByTestId("chart-stale")).toHaveCount(0);

    // The sync endpoint stops answering. After two failed polls the chart says so.
    const sync = "**/api/desk/replay/sessions/*/advance";
    await page.route(sync, (route) => route.abort());
    await expect(page.getByTestId("chart-stale")).toContainText(/^Not updating · last data /, { timeout: 60_000 });
    await expect(page.getByTestId("chart-slot").locator('[data-dim="true"]')).toBeVisible();
    await expect(readout(page), "no answer, no new time").toHaveText(frozen);

    // It answers again: the notice goes and the chart is clear.
    await page.unroute(sync);
    await expect(page.getByTestId("chart-stale")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("chart-slot").locator('[data-dim="true"]')).toHaveCount(0);
  });

  test("a failed read at the clock shows the error with Retry, not silent dashes, and Retry reads again", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startThread(page, context);
    const live = (url: URL) => url.pathname.includes("/replay/day-lists/") && url.searchParams.get("live") === "true";
    await page.route(live, (route) => route.abort());
    await openFirstDay(page);
    const candidates = page.getByRole("region", { name: "Candidates" });
    const failed = candidates.getByRole("alert").filter({ hasText: practiceText("dayLiveError", {}).replace(/ · Try again$/, "") });
    await expect(failed).toBeVisible({ timeout: 60_000 });
    await page.unroute(live);
    await failed.getByRole("button", { name: /try again/i }).click();
    await expect(failed).toHaveCount(0, { timeout: 60_000 });
    await expect(candidates.getByRole("row", { name: /TSLA/ })).toBeVisible();
  });

  test("ten day threads fill the day-trade slots: the hub says so, the form switches Day off with the reason, and an eleventh is refused", async ({ page, context }) => {
    test.setTimeout(240_000);
    for (let n = 0; n < 9; n += 1) await createThreadByApi(context);
    await openDesk(page, "/practice");
    await expect(page.getByTestId("day-slots")).toHaveText("Day-trade slots 9 of 10");
    await createThreadByApi(context);
    await openDesk(page, "/practice");
    const slots = page.getByTestId("day-slots");
    await expect(slots).toHaveText("Day-trade slots 10 of 10");

    // The server refuses the eleventh with its sentence, on the field the form shows it at.
    const refused = await context.request.post(`${origin}/api/desk/replay/threads`, { data: { schemaVersion: 1, mode: "day", startingBalance: 50000, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } } });
    expect(refused.status()).toBe(409);
    const body = await refused.json();
    expect(JSON.stringify(body)).toContain(practiceText("daySlotsFull", { max: 10 }));
    const counted = await (await context.request.get(`${origin}/api/desk/replay/threads/capacity`)).json();
    expect(counted).toEqual({ day_active: 10, day_max: 10 });

    // The form: Start waits with the day-slots sentence (there is no Day/Swing choice any more, ADR-0025).
    await page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#new-plan-note")).toHaveText(practiceText("daySlotsFull", { max: 10 }));
    await expect(dialog.getByRole("button", { name: /^Start (\d+-day )?(swing )?practice$/ })).toHaveAttribute("aria-disabled", "true");
  });
});
