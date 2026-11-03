import type { Page } from "@playwright/test";
import { origin } from "../helpers";
import { stepBar } from "./clock-helpers";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { openFirstDay, saveFilter, startThread } from "./hub-helpers";

// D-206: the replay chart's own refresh held the page. A day thread's chart asks the server every 2 s (`advance {sync: true}`) and draws the answer;
// each answer, new bar or none, re-rendered the chart's whole source-bar data table (one row per bar, 6,000 at 1m) and handed every series the whole
// data again: a main-thread task of 550 to 620 ms for each new bar at 1m, 190 to 210 ms for an idle poll at 5m, 73 to 88 ms at 15m, once a window.
// A poll that brings nothing new must cost close to nothing, and a new bar must not cost more at 6,000 bars than at 60.
//
// The page watches its own long tasks (a task of 50 ms or more on the main thread). The ceilings are well under the old figures and well over the new
// ones, so a loaded machine does not trip them. The market moves through the thread's clock route (what Play, Step and Pause in another window end
// up calling); the chart follows it on its own.

const SESSION_URL = /\/practice\/replay\?id=\d+/;
const SYMBOL = "XOM"; // a name no other spec opens on its own: the server keeps the prepared bars of every name it has served
const EVERY_NAME = {
  schemaVersion: 1,
  name: "Every name",
  watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
  liquidity: { minPrice: 1, minAvgVolume: 1 },
  when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
  maxResults: 50,
};
/** Longest single task a new bar may cost, and the main-thread time of the polls of a still clock, in ms (the old page: 550 and 190 at best). */
const BAR_TASK_CEILING_MS = 150;
const IDLE_TOTAL_CEILING_MS = 100;

type Watched = Window & { __tasks?: number[] };

const watch = (page: Page) =>
  page.evaluate(() => {
    const tasks: number[] = [];
    (window as Watched).__tasks = tasks;
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => tasks.push(Math.round(entry.duration)))).observe({ entryTypes: ["longtask"] });
  });
/** The long tasks seen since the last call, in ms. */
const drain = (page: Page) => page.evaluate(() => (window as Watched).__tasks!.splice(0));
const chartLabel = (interval: string) => `section[aria-label='${SYMBOL} ${interval} market chart']`;
const sourceBars = async (page: Page, interval: string) =>
  Number(/(\d+) source bars/.exec((await page.locator(`${chartLabel(interval)} details summary`).textContent()) ?? "")?.[1] ?? -1);
const showInterval = async (page: Page, interval: string) => {
  await page.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: interval, exact: true }).click();
  await expect(page.locator(chartLabel(interval))).toBeVisible();
};
const threadOf = async (page: Page): Promise<number> => {
  const id = /id=(\d+)/.exec(page.url())![1];
  const session = await (await page.context().request.get(`${origin}/api/desk/replay/sessions/${id}`)).json();
  return session.thread_id;
};
const sum = (tasks: number[]) => tasks.reduce((total, ms) => total + ms, 0);

test("a replay chart that polls and takes new bars does not hold the page: 1m, 5m, 15m, two windows at 10x (D-206)", async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);
  await prepareDesk(context);
  await saveFilter(context, EVERY_NAME);
  await startThread(page, context, { filter: EVERY_NAME.name });
  await openFirstDay(page);
  await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: new RegExp(SYMBOL) }).getByText(SYMBOL, { exact: true }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: SYMBOL, level: 1 })).toBeVisible();
  await expect.poll(() => sourceBars(page, "1m"), { message: "the 1m lookback is loaded", timeout: 30_000 }).toBeGreaterThan(1000);
  const measured: Record<string, unknown> = {};
  const report = (label: string, tasks: number[]) => {
    measured[label] = tasks;
    console.log(`D-206 ${label}: ${JSON.stringify(tasks)} ms`);
  };

  // 1m: each new bar. Three bars, the longest task after each.
  await watch(page);
  await page.waitForTimeout(2500); // the load's own work settles
  await drain(page);
  const bars1m = await sourceBars(page, "1m");
  const barTasks: number[] = [];
  for (let bar = 0; bar < 3; bar += 1) {
    await stepBar(page);
    await page.waitForTimeout(600);
    const tasks = await drain(page);
    report(`1m bar ${bar + 1}`, tasks);
    barTasks.push(Math.max(0, ...tasks));
  }
  expect(await sourceBars(page, "1m"), "the chart took the three bars").toBe(bars1m + 3);

  // 5m and 15m, clock paused: three polls (2 s apart) with nothing new must not cost a task.
  for (const interval of ["5m", "15m"]) {
    await showInterval(page, interval);
    await page.waitForTimeout(2500);
    await drain(page);
    await page.waitForTimeout(6500);
    const idle = await drain(page);
    report(`${interval} idle poll x3, ${await sourceBars(page, interval)} source bars`, idle);
    expect.soft(sum(idle), `${interval}: main-thread time of the polls of a still clock, ms (${JSON.stringify(idle)})`).toBeLessThan(IDLE_TOTAL_CEILING_MS);
    // And a new bar at this interval: the forming candle moves with each minute of the clock.
    await stepBar(page);
    await page.waitForTimeout(600);
    const stepped = await drain(page);
    report(`${interval} bar`, stepped);
    expect.soft(Math.max(0, ...stepped), `${interval}: the longest task a new bar costs, ms (${JSON.stringify(stepped)})`).toBeLessThan(BAR_TASK_CEILING_MS);
  }
  await showInterval(page, "1m");
  await page.waitForTimeout(2500);

  // Two windows on the same chart, the clock running at 10x: six or so bars in 30 s, one 550 to 660 ms task for each in each window.
  const second = await context.newPage();
  const url = new URL(page.url());
  await openDesk(second, url.pathname + url.search);
  await expect(second.getByRole("heading", { name: SYMBOL, level: 1 })).toBeVisible();
  await expect.poll(() => sourceBars(second, "1m"), { timeout: 30_000 }).toBeGreaterThan(1000);
  await watch(second);
  await page.waitForTimeout(2500);
  await drain(page);
  await drain(second);
  const thread = await threadOf(page);
  const before = await sourceBars(page, "1m");
  const control = (data: Record<string, unknown>) => context.request.post(`${origin}/api/desk/replay/threads/${thread}/clock`, { data });
  expect((await control({ speed: 10 })).ok()).toBeTruthy();
  expect((await control({ running: true })).ok()).toBeTruthy();
  await page.waitForTimeout(40_000); // 10x: ten market seconds a second, so six or so one-minute bars
  expect((await control({ running: false })).ok()).toBeTruthy();
  await page.waitForTimeout(2500);
  const windowA = await drain(page);
  const windowB = await drain(second);
  report("10x window A", windowA);
  report("10x window B", windowB);
  const taken = (await sourceBars(page, "1m")) - before;
  expect.soft(taken, "the chart took the bars the clock ran through").toBeGreaterThanOrEqual(5);
  expect.soft(Math.max(0, ...windowA), `window A: the longest task at 10x, ms (${JSON.stringify(windowA)})`).toBeLessThan(BAR_TASK_CEILING_MS);
  expect.soft(Math.max(0, ...windowB), `window B: the longest task at 10x, ms (${JSON.stringify(windowB)})`).toBeLessThan(BAR_TASK_CEILING_MS);
  await second.close();

  testInfo.annotations.push({ type: "long tasks (ms)", description: JSON.stringify(measured) });
  expect.soft(Math.max(...barTasks), `1m: the longest task a new bar costs, ms (${JSON.stringify(barTasks)})`).toBeLessThan(BAR_TASK_CEILING_MS);
});
