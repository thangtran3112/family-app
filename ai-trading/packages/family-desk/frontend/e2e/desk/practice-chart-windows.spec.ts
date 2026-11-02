import type { Page } from "@playwright/test";
import { stepBar } from "./clock-helpers";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { openFirstDay, saveFilter, startThread } from "./hub-helpers";

// D-198: the same replay chart open in two windows. The server keeps one playhead per session, and a followed chart used to be answered with only the
// bars that playhead moved over, so the window that polled first took each bar and the other never got it. Every window must show every closed bar
// through the thread clock. The market moves through the thread's clock route (what Play, and Pause in another window, end up calling).

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

/** What a window shows: the chart data table's bar count and its last row, and the VWAP of the chart legend. */
async function read(page: Page) {
  const summary = (await page.locator("details summary", { hasText: "Chart data table" }).first().textContent()) ?? "";
  const lastRow = (await page.locator("details table tbody tr th").last().textContent()) ?? "";
  const vwap = /VWAP\s+(\d+\.\d+|—)/.exec(await page.locator("#main-content").innerText())?.[1] ?? null;
  return { bars: Number(/(\d+) source bars/.exec(summary)?.[1] ?? -1), lastRow, vwap };
}

test("the same replay chart in two windows shows every closed bar through the thread clock in both (D-198)", async ({ page, context }) => {
  test.setTimeout(240_000);
  await prepareDesk(context);
  await saveFilter(context, EVERY_NAME);
  await startThread(page, context, { filter: EVERY_NAME.name });
  await openFirstDay(page);
  await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: new RegExp(SYMBOL) }).getByText(SYMBOL, { exact: true }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: SYMBOL, level: 1 })).toBeVisible();
  const second = await context.newPage();
  const url = new URL(page.url());
  await openDesk(second, url.pathname + url.search);
  await expect(second.getByRole("heading", { name: SYMBOL, level: 1 })).toBeVisible();
  const open = await read(page);
  expect((await read(second)).bars).toBe(open.bars);

  // 9:31 to 9:34: each bar the clock reveals reaches both windows (the poll is 2 s: a window is never more than a couple of polls behind).
  for (let bar = 1; bar <= 4; bar += 1) {
    await stepBar(page);
    await expect.poll(async () => (await read(page)).bars, { message: `window A, bar ${bar}`, timeout: 15_000 }).toBe(open.bars + bar);
    await expect.poll(() => read(second), { message: `window B, bar ${bar}: the same bars, last bar and VWAP as window A`, timeout: 15_000 }).toEqual(await read(page));
  }

  // A reload reads everything revealed so far: neither window is missing a bar it holds.
  const shown = await read(page);
  await second.reload();
  await expect(second.getByRole("heading", { name: SYMBOL, level: 1 })).toBeVisible();
  await expect.poll(() => read(second), { message: "window B after a reload", timeout: 15_000 }).toEqual(shown);
  await second.close();
});
