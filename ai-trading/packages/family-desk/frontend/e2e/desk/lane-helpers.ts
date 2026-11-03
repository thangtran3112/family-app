import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { stepBar } from "./clock-helpers";
import { expect, openDesk } from "./helpers";
import { REPLAY_URL, SCREEN_URL, createThreadByApi, openLaneByApi, replayRail, saveFilter, scanByApi, startThread } from "./hub-helpers";

// A lane is one name of a freestyle thread (ADR-0025): its chart is the thread's time on that name, and it never ends. These are the steps the chart,
// ticket, switch and Portfolio specs share on top of hub-helpers: a lane opened on a thread made through the API, the Screen scanned and opened, a way
// back to it, and the "Every name" filter that lists the whole stub universe.
// The stub day is TSLA on Fri 2026-09-25 (`replay/fixture.py`): the thread starts at 09:30 ET with its clock paused, and the bars run to 09:40.

/** A thread with its setup and a lane on `symbol`, opened on its replay screen at the thread's start (09:30 ET). Returns both ids. */
export async function startLane(
  page: Page,
  context: BrowserContext,
  options: { symbol?: string; thread?: Parameters<typeof createThreadByApi>[1] } = {},
): Promise<{ threadId: number; sessionId: number }> {
  const symbol = options.symbol ?? "TSLA";
  const threadId = await createThreadByApi(context, options.thread);
  const sessionId = await openLaneByApi(context, threadId, symbol);
  await openDesk(page, `/practice/replay?id=${sessionId}`);
  await expect(page.getByRole("heading", { name: symbol, level: 1 })).toBeVisible();
  await expect(page.getByTestId("thread-clock-time")).toContainText("9:30:00");
  return { threadId, sessionId };
}

/** A lane with two bars revealed, so there is a last print to trade at, and the Practice rail. */
export async function openTicket(page: Page, context: BrowserContext, options: Parameters<typeof startLane>[2] = {}) {
  const lane = await startLane(page, context, options);
  await stepBar(page, 2);
  await expect(page.getByTestId("thread-clock-time")).not.toContainText("9:30:00");
  return { ...lane, practice: await replayRail(page, "Practice") };
}

/** The thread's Screen, scanned at the thread's time and open on its Candidates table. */
export async function openScreen(page: Page, context: BrowserContext, threadId: number) {
  await scanByApi(context, threadId);
  await openDesk(page, `/practice/screen?thread=${threadId}`);
  await expect(page.getByRole("table", { name: "Candidates" })).toBeVisible({ timeout: 60_000 });
}

/** A chart's way back to the Screen is the tab strip above it: there is no Back link or foot bar. */
export async function backToScreen(page: Page) {
  await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: PRACTICE_COPY.tabScreen, exact: true }).click();
  await page.waitForURL(SCREEN_URL);
}

/** A saved filter that lists every name of the stub universe (TSLA and its three stand-ins at a fraction of its price). */
export const EVERY_NAME = {
  schemaVersion: 1,
  name: "Every name",
  watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
  liquidity: { minPrice: 1, minAvgVolume: 1 },
  when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
  maxResults: 50,
};

/**
 * A thread started through the New thread modal on `EVERY_NAME`, its Screen scanned, and `symbol` opened from its row: the whole way a name reaches a chart.
 * The server keeps the prepared bars of every name it has served, so a spec that measures a chart picks a name no other spec opens on its own (XOM).
 */
export async function openNameFromScreen(page: Page, context: BrowserContext, symbol: string): Promise<number> {
  await saveFilter(context, EVERY_NAME);
  const threadId = await startThread(page, context, { filter: EVERY_NAME.name });
  await openScreen(page, context, threadId);
  await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: new RegExp(symbol) }).getByText(symbol, { exact: true }).click();
  await page.waitForURL(REPLAY_URL);
  await expect(page.getByRole("heading", { name: symbol, level: 1 })).toBeVisible();
  return threadId;
}
