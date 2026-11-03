import type { BrowserContext, Page } from "@playwright/test";
import { formatPrice } from "../../lib/desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { DAY, ET_OFFSET, createThreadByApi, expectNoDayLanguage, jumpByApi, openLaneByApi, scanByApi } from "./hub-helpers";

// One thread time (ADR-0022, ADR-0025). The thread's clock is the server's; every screen of the thread reads the time of its own payload and shows it in the
// one format, and a screen that stops being updated says so. The stub day is TSLA on Fri 2026-09-25 (extended-hours bars to 8:00 PM ET); the clock goes
// on through the night and the weekend, and a lane's price stands still at the last print while the market is closed.

const readout = (page: Page) => page.getByTestId("thread-clock-time");
const summaryUrl = (threadId: number) => `/practice/thread?id=${threadId}`;

/** A thread started at 9:35 AM ET on the stub day with TSLA's lane open. Returns the thread, the lane and the lane's chart address. */
async function startLane(context: BrowserContext): Promise<{ threadId: number; sessionId: number; chart: string }> {
  const threadId = await createThreadByApi(context, { startAt: `${DAY}T09:35:00${ET_OFFSET}` });
  const sessionId = await openLaneByApi(context, threadId, "TSLA");
  return { threadId, sessionId, chart: `/practice/replay?id=${sessionId}` };
}

test.describe("Practice: one thread time", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("overnight on the weekend at 1:22 AM the Summary, the chart and the Screen show the same date and time, and the price stands still with the market closed", async ({ page, context }) => {
    test.setTimeout(300_000);
    const { threadId, sessionId, chart } = await startLane(context);
    await scanByApi(context, threadId); // the Screen lists TSLA

    // The clock is paused (nobody pressed Play), so every screen reads exactly the instant we set: Saturday 1:22:24 AM ET, hours past the 8:00 PM end of the tape.
    const target = "2026-09-26T05:22:24Z";
    await jumpByApi(context, threadId, target);
    const WHEN = "Sat 2026-09-26 · 1:22:24 AM ET";

    // The server's payloads say the same thing: T is the clock, the data stops at or before it, the market is closed (I1).
    const feed = await (await context.request.get(`${origin}/api/desk/replay/sessions/${sessionId}/feed`)).json();
    expect(Date.parse(feed.thread_time)).toBe(Date.parse(target));
    expect(Date.parse(feed.data_through), "nothing after T is in the payload").toBeLessThanOrEqual(Date.parse(target));
    expect(feed.market.phase).toBe("closed");

    // The Summary.
    await openDesk(page, summaryUrl(threadId));
    await expect(readout(page)).toHaveText(WHEN);
    await expect(page.getByText(/hidden day|show date|replayed market date/i)).toHaveCount(0);

    // The chart (a lane opens at the clock): the same date and time in the readout, the top-bar chip and the status bar, the closed market beside the
    // still-counting time, and a price that is the last print and does not move.
    await openDesk(page, chart);
    await expect(readout(page)).toHaveText(WHEN);
    await expect(page.getByText(`Replay · ${WHEN}`)).toBeVisible();
    await expect(page.getByLabel("Status")).toContainText("Replay clock");
    await expect(page.getByTestId("market-closed")).toContainText("Market closed · data through ");
    const price = page.locator("dt", { hasText: "Last price" }).locator("xpath=following-sibling::dd");
    await expect(price).toHaveText(formatPrice(feed.last.price));
    await page.waitForTimeout(5000); // two sync polls later
    await expect(price, "closed: the price is frozen at the last print").toHaveText(formatPrice(feed.last.price));
    await expect(readout(page)).toHaveText(WHEN);
    await expect(page.getByTestId("chart-stale")).toHaveCount(0);
    const again = await (await context.request.get(`${origin}/api/desk/replay/sessions/${sessionId}/feed`)).json();
    expect(again.last, "a read moves nothing (I5)").toEqual(feed.last);
    await expectCleanScreen(page);

    // The Screen: the same time, the market closed, and each name priced at the same last print as the chart.
    await openDesk(page, `/practice/screen?thread=${threadId}`);
    await expect(page.getByTestId("day-clock-time")).toHaveText(WHEN);
    await expect(page.getByTestId("market-closed")).toContainText("Market closed · data through ");
    const screen = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/screen?live=true`)).json();
    expect(Date.parse(screen.clock)).toBe(Date.parse(target));
    expect(screen.market.phase).toBe("closed");
    expect(screen.candidates.find((row: { symbol: string }) => row.symbol === "TSLA").live.price, "one price function: the Screen prices TSLA as the chart does").toBe(feed.last.price);
    await expect(page.getByText(`Replay · ${WHEN}`)).toBeVisible();
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("a chart whose sync polls fail freezes its readout, dims, and says it is not updating; it recovers on the next answer", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { chart } = await startLane(context);
    await openDesk(page, chart);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
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

  test("a failed read of the Screen at the clock shows the error with Retry, not silent dashes, and Retry reads again", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await createThreadByApi(context);
    await scanByApi(context, threadId);
    const live = (url: URL) => url.pathname.includes(`/replay/threads/${threadId}/screen`) && url.searchParams.get("live") === "true";
    await page.route(live, (route) => route.abort());
    await openDesk(page, `/practice/screen?thread=${threadId}`);
    const candidates = page.getByRole("region", { name: "Candidates" });
    const failed = candidates.getByRole("alert").filter({ hasText: practiceText("screenLiveError", {}).replace(/ · Try again$/, "") });
    await expect(failed).toBeVisible({ timeout: 60_000 });
    await page.unroute(live);
    await failed.getByRole("button", { name: /try again/i }).click();
    await expect(failed).toHaveCount(0, { timeout: 60_000 });
    await expect(candidates.getByRole("row", { name: /TSLA/ })).toBeVisible();
  });

  test("ten threads fill the thread slots: the hub says so, the form says Start is off with the reason, and an eleventh is refused", async ({ page, context }) => {
    test.setTimeout(240_000);
    for (let n = 0; n < 9; n += 1) await createThreadByApi(context);
    await openDesk(page, "/practice");
    await expect(page.getByTestId("day-slots")).toHaveText("Thread slots 9 of 10");
    await createThreadByApi(context);
    await openDesk(page, "/practice");
    const slots = page.getByTestId("day-slots");
    await expect(slots).toHaveText("Thread slots 10 of 10");
    await expect(slots).toHaveAttribute("data-full", "true");

    // The server refuses the eleventh with its sentence, on the field the form shows it at.
    const refused = await context.request.post(`${origin}/api/desk/replay/threads`, { data: { schemaVersion: 1, mode: "day", startingBalance: 50000, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } } });
    expect(refused.status()).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain("slots are in use");
    const counted = await (await context.request.get(`${origin}/api/desk/replay/threads/capacity`)).json();
    expect(counted).toEqual({ day_active: 10, day_max: 10 });

    // The form: Start waits with the thread-slots sentence.
    await page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#new-plan-note")).toHaveText(practiceText("threadSlotsFull", { max: 10 }));
    await expect(dialog.getByRole("button", { name: /^Start thread$/ })).toHaveAttribute("aria-disabled", "true");
  });
});
