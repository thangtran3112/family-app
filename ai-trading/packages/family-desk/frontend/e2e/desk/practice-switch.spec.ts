import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { endDayFromSummary, stepBar } from "./clock-helpers";
import { expect, expectCleanScreen, prepareDesk, test } from "./helpers";
import { START_BUTTON, THREAD_URL, fillNewPlan, openFirstDay, openNewPlan, saveFilter, setRiskPlan, threadIdOf } from "./hub-helpers";
import { backToDayList, placeOrder, replayRail } from "./swing-helpers";

// Switching names on the shared day clock (02o-b2). The stub holds TSLA on Fri 2026-09-25, and three stand-in names that
// replay TSLA's day at a fraction of its prices (`replay/fixture.py`), so one daily list holds four names. Every session
// replays 09:30 to 09:40 ET at 1-minute bars; `stepBar` moves the thread's server-side clock one bar (a chart has no Step).

const DAY = "2026-09-25";
const FIRST_RECORDED = "2026-09-18"; // 20 finished sessions before the E2E clock
const SESSION_URL = /\/practice\/replay\?id=\d+/;

const playhead = (page: Page) => page.getByTestId("thread-clock-time"); // the thread's one time, read-only text on every chart

/** The marks she has placed on the name on screen (the bottom panel is collapsed at 1180 until its tab opens). */
async function marks(page: Page) {
  await page.getByRole("tab", { name: "Marks" }).click();
  // A focused tab owns the arrow keys (ui/Tabs moves between tabs): hand the keyboard back to the replay, whose → steps.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return page.getByRole("tabpanel");
}

/** The day's portfolio is the Portfolio tab's, never the chart view's (owner, 2026-11-01): open the tab from a chart and read it there. */
async function portfolioPanel(page: Page) {
  const region = page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
  await expect(region, "a chart shows no portfolio").toHaveCount(0);
  await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: "Portfolio", exact: true }).click();
  await page.waitForURL(/\/practice\/thread\?id=\d+&tab=portfolio/);
  await expect(region).toBeVisible();
  return region;
}

/** From the Portfolio tab back onto a name's chart, through its row (the tab's way into a chart). */
async function openFromPortfolio(page: Page, symbol: string) {
  await page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true }).getByRole("button", { name: `Switch to ${symbol}` }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: symbol, level: 1 })).toBeVisible();
}

/** The Desk "recorded" these mornings' universes (`universe_days`); the e2e server writes the rows the premarket pass would. */
async function recordUniverse(context: BrowserContext, days: { day: string; symbols: string[] }[]) {
  expect((await context.request.post(`${origin}/api/desk/__e2e/universe-days`, { data: { days } })).ok()).toBeTruthy();
}

/** A filter that lists every name the stub has bars for, and a thread with a plan started through the New plan modal. */
async function startEveryNamePlan(page: Page, context: BrowserContext) {
  const all = {
    schemaVersion: 1,
    name: "Every name",
    watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
    liquidity: { minPrice: 1, minAvgVolume: 1 },
    when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
    maxResults: 50,
  };
  await saveFilter(context, all);
  const dialog = await openNewPlan(page);
  await fillNewPlan(dialog, { filter: "Every name" });
  await expect(dialog.getByText("Names a day"), "no cap on names to pick").toHaveCount(0);
  await dialog.getByRole("button", { name: START_BUTTON }).click();
  await page.waitForURL(THREAD_URL, { timeout: 90_000 });
  await setRiskPlan(context, threadIdOf(page)); // this spec is not about stops (D-060): Stop on every entry is No
  await openFirstDay(page);
}

test.describe("Practice: switching names", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a click opens a name at the day clock, a name left behind catches up, and every list name opens", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    const table = page.getByRole("table", { name: "Candidates" });
    for (const symbol of ["TSLA", "LRCX", "PANW", "XOM"]) await expect(table.getByRole("row", { name: new RegExp(symbol) })).toBeVisible();

    // No star and no cap: a day opens any list name, and the portfolio starts empty.
    await expect(page.getByRole("button", { name: /star/i })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/names practiced today|limits a day|Starred \d+ of/);
    await expectCleanScreen(page);

    // Click TSLA's row: its chart opens at once. Take it three bars in, and take a trade.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");
    const tslaPlayhead = (await playhead(page).textContent()) ?? "";
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");

    // The Portfolio tab shows it (the chart itself shows none): TSLA is Long. Its row leads back onto the chart.
    let portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(/Long \d+ @ \$/);
    await openFromPortfolio(page, "TSLA");

    // Exit TSLA here; the next section opens LRCX at the clock TSLA reached. Holding several names at once has its own test below.
    await placeOrder(page, "Close position");
    await expect(await marks(page)).toContainText("Practice exit");

    // Opening LRCX takes the clock TSLA reached, not the window start.
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await table.getByRole("row", { name: /LRCX/ }).getByText("LRCX", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(tslaPlayhead);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await stepBar(page);
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:35");
    const clock = (await playhead(page).textContent()) ?? "";
    await expectCleanScreen(page);

    // A new Long on LRCX joins the portfolio; TSLA's row stays a plain switch (no "Close LRCX first").
    await placeOrder(page, "Buy");
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText(/Long \d+ @ \$/);
    const tslaRow = portfolio.getByRole("button", { name: "Switch to TSLA" });
    await expect(tslaRow).not.toHaveAttribute("aria-disabled", "true");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).not.toContainText(/Close LRCX first/);
    await openFromPortfolio(page, "LRCX");
    await placeOrder(page, "Close position");
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText("Flat");
    await expect(tslaRow).not.toHaveAttribute("aria-disabled", "true");

    // TSLA stayed at 9:33 while the clock moved on: its row says it is behind. Switching to it lifts it to the day clock (the
    // server adds the away span), so it can be marked at once.
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayBehind);
    await expect(portfolio.locator("li")).toHaveCount(2);
    await openFromPortfolio(page, "TSLA");
    await expect(playhead(page)).toHaveText(clock);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();
    await expectCleanScreen(page);
    await placeOrder(page, "Buy");
    await expect((await marks(page)).getByText("Practice buy")).toHaveCount(2); // the first trade and the one after the lift
    await placeOrder(page, "Close position");

    // Past the old two-name limit: a third and a fourth name open, and a name in hand switches back.
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /PANW/ }).getByRole("button", { name: "Open PANW" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "PANW", level: 1 })).toBeVisible();
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /XOM/ }).getByText("XOM", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "XOM", level: 1 })).toBeVisible();
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await expect(page.locator("body")).not.toContainText(/names practiced today|allows \d+ names/);
    await expect(page.getByRole("row", { name: /LRCX/ }).getByRole("button", { name: "Switch to LRCX" })).toHaveText("Switch"); // a name in hand switches back
    // The day list is only the list of names: its portfolio is the Portfolio tab's, not a section of this screen.
    await expect(page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Day context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio })).toHaveCount(0);
    // The day's header opens the whole day on its shared clock; Resume is the thread clock's word alone, so no button on this screen says it.
    await expect(page.getByRole("button", { name: /^Resume/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Open Day \d+$/ })).toBeVisible();
    await expectCleanScreen(page);

    // The whole day ends together: every opened name scores.
    await endDayFromSummary(page);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("the thread's time is text on a chart, never a bar: no Play, Step, speed or Jump under or above any name, and the chart's own controls stay with the chart", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();

    const readout = page.getByTestId("thread-time-readout");
    const slot = page.getByTestId("chart-slot");
    const toolbar = page.getByTestId("chart-toolbar");
    // The thread's time and whether it runs, as plain text with a way to the Summary: nothing to press but that link.
    await expect(readout).toBeVisible();
    await expect(readout.getByText(PRACTICE_COPY.threadTime, { exact: true })).toBeVisible();
    await expect(readout).toContainText("Paused");
    await expect(readout, "it names the thread, not one ticker").not.toContainText("TSLA");
    await expect(readout.getByRole("link", { name: PRACTICE_COPY.chartClockLink })).toBeVisible();
    await expect(readout.getByRole("button")).toHaveCount(0);
    // Play, Step, speed, Jump and the clock panel are not on the chart: not above it, not under it, not in the toolbar.
    await expect(page.getByTestId("thread-clock")).toHaveCount(0);
    for (const name of ["Play", "Pause", "Step", "Jump"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${name}`) }), `${name} is not on a chart`).toHaveCount(0);
    }
    await expect(page.getByRole("group", { name: "Replay speed" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 }).locator("xpath=ancestor::div[1]")).not.toContainText(/Paused|Playing/);
    // The interval, Chart settings and Full screen are the chart's, under it.
    await expect(toolbar.getByRole("group", { name: "Chart interval" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^Chart/ })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Full screen" })).toBeVisible();

    // Placement: the thread's time is above the name's header and chart; the chart's controls are under the chart.
    const box = async (locator: typeof readout) => (await locator.boundingBox())!;
    const [readBox, titleBox, slotBox, toolbarBox] = [await box(readout), await box(page.getByRole("heading", { name: "TSLA", level: 1 })), await box(slot), await box(toolbar)];
    expect(readBox.y + readBox.height, "the thread's time ends above the ticker header").toBeLessThanOrEqual(titleBox.y);
    expect(slotBox.y + slotBox.height, "the chart toolbar sits under the chart").toBeLessThanOrEqual(toolbarBox.y + 1);
    expect(readBox.y, "the thread's time is above the chart").toBeLessThan(slotBox.y);

    // Practice has no keyboard shortcuts: ? lists nothing, and Space neither plays nor says anything (the time moves from the Summary only).
    const at = await playhead(page).textContent();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await page.keyboard.press("Space");
    await page.waitForTimeout(1500);
    await expect(readout).toContainText("Paused");
    await expect(playhead(page)).toHaveText(at ?? "");
    await expectCleanScreen(page);
  });

  test("the thread's clock moves for every name: a chart reopened from its own address opens on the thread's time, and the other name opens at that one time", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    const tslaUrl = page.url();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");

    // LRCX opens at the thread's time and the clock moves on two bars; TSLA, off screen, stays where it was.
    await openName(page, dayUrl, "LRCX");
    await expect(playhead(page)).toContainText("9:33");
    await stepBar(page, 2);
    await expect(playhead(page)).toContainText("9:35");

    // TSLA, opened again from its own address, follows the thread's clock as it loads: 9:35, not its own 9:33, and it can be marked at once.
    await page.goto(tslaUrl);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toContainText("9:35");
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await expect(page.locator(".dk-status"), "the status bar reads the thread's clock too").toContainText("Replay clock 9:35");
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();

    // One more bar of the thread's clock is 9:36 on every chart.
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:36");
    await openName(page, dayUrl, "LRCX");
    await expect(playhead(page)).toContainText("9:36");
    await expectCleanScreen(page);
  });

  /** Money in a text as numbers: "+$1,204.50" is 1204.5 and "−$310.00" is -310. */
  const amounts = (text: string | null) =>
    [...(text ?? "").matchAll(/([+−-])?\$([\d,]+\.\d{2})/g)].map((found) => (found[1] === "+" || found[1] === undefined ? 1 : -1) * Number(found[2]!.replace(/,/g, "")));

  /** Opens a name from the day list's table and lands on its replay. */
  async function openName(page: Page, dayUrl: string, symbol: string) {
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: new RegExp(symbol) }).getByText(symbol, { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: symbol, level: 1 })).toBeVisible();
  }

  test("two names hold open trades at once: the Portfolio shows 2 open and their combined total, a held name exits from the other chart, and End day names what it exits", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();

    // Long TSLA three bars in, Back, open LRCX at the same clock and go Short: both trades stay open.
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");
    await openName(page, dayUrl, "LRCX");
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await placeOrder(page, "Sell");
    await expect(await marks(page)).toContainText("Practice sell");
    // Move the clock so both trades have a P/L worth adding up.
    await stepBar(page);
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:35");

    // The Portfolio holds both names, each with its side, and its footer says how many are open and the combined total.
    const portfolio = await portfolioPanel(page);
    const tsla = portfolio.locator('[data-symbol="TSLA"]');
    const lrcx = portfolio.locator('[data-symbol="LRCX"]');
    await expect(tsla).toContainText(/Long \d+ @ \$/);
    await expect(lrcx).toContainText(/Short \d+ @ \$/);
    await expect(tsla.getByRole("button", { name: "Exit TSLA" })).toBeVisible();
    await expect(lrcx.getByRole("button", { name: "Exit LRCX" })).toBeVisible();
    const total = portfolio.getByTestId("portfolio-total");
    await expect(total).toContainText(PRACTICE_COPY.dayPortfolioTotal);
    await expect(total).toContainText("2 open");
    await expect(total).toContainText("as of");
    await expect(portfolio.getByTestId("portfolio-row-total")).toHaveCount(2);
    // The head counts the open positions, and each row's arrow follows the sign of its P/L (up green, down red, none at zero).
    await expect(portfolio.getByTestId("portfolio-count")).toHaveText("2 open positions");
    for (const row of [tsla, lrcx]) {
      const [pnl] = amounts(await row.getByTestId("portfolio-row-total").textContent());
      await expect(row.getByTestId("portfolio-row-arrow")).toHaveText(pnl! > 0 ? "▲" : pnl! < 0 ? "▼" : "");
      await expect(row.getByTestId("portfolio-row-change")).toHaveText(/^[+−]?\$[\d,]+\.\d{2}$/); // the stock's move since entry, per share
    }
    // The switch flips the price change and the P/L together: dollars to percent and back.
    await portfolio.getByRole("radio", { name: "%" }).click();
    await expect(portfolio.getByTestId("portfolio-row-total")).toHaveText([/^[+−]?\d+\.\d{2}%$/, /^[+−]?\d+\.\d{2}%$/]);
    await expect(portfolio.getByTestId("portfolio-row-change")).toHaveText([/^[+−]?\d+\.\d{2}%$/, /^[+−]?\d+\.\d{2}%$/]);
    await portfolio.getByRole("radio", { name: "$" }).click();
    await expect(portfolio.getByTestId("portfolio-row-total")).toHaveText([/^[+−]?\$[\d,]+\.\d{2}$/, /^[+−]?\$[\d,]+\.\d{2}$/]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // a focused segment owns the arrow keys
    // The footer is read from the server after the clock settles, so it can trail the rows by one read: wait for it to agree.
    await expect
      .poll(async () => {
        const rows = await portfolio.getByTestId("portfolio-row-total").allTextContents();
        const [headline] = amounts(await total.textContent());
        return Math.round(((headline ?? NaN) - rows.flatMap((text) => amounts(text)).reduce((sum, value) => sum + value, 0)) * 100);
      }, { message: "the Day P/L is the two rows added up" })
      .toBe(0);
    await expect(portfolio.getByText(PRACTICE_COPY.threadSimulated).first()).toBeVisible();
    await expectCleanScreen(page);

    // The hub's Today line adds the open trades, with the same open figure and its SIMULATED badge.
    const [, , open] = amounts(await total.textContent());
    await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: PRACTICE_COPY.tabSummary }).click();
    await page.waitForURL(THREAD_URL);
    const todayOpen = page.getByRole("region", { name: "Practice day" }).getByTestId("today-open");
    await expect(todayOpen).toContainText("2 open");
    expect(amounts(await todayOpen.textContent())[0]).toBeCloseTo(open!, 2);
    await expect(page.getByRole("region", { name: "Practice day" }).getByText(PRACTICE_COPY.threadSimulated)).toBeVisible();
    await page.goBack(); // the Portfolio tab again
    await expect(portfolio).toBeVisible();

    // Exit TSLA from its row: it goes flat, books its trade, and one trade is left open. LRCX's chart opens from its row, still held.
    await portfolio.locator('[data-symbol="TSLA"]').getByRole("button", { name: "Exit TSLA" }).click();
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("Flat");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("1 trade");
    await expect(portfolio.getByTestId("portfolio-total")).toContainText("1 open");
    await expect(portfolio.getByTestId("portfolio-count")).toHaveText("1 open position");
    await openFromPortfolio(page, "LRCX");

    // The Summary asks before it exits what is still open, and names it.
    await page.getByRole("tab", { name: "Summary" }).click();
    await page.getByRole("button", { name: PRACTICE_COPY.clockEndDay, exact: true }).click();
    const confirm = page.getByRole("group", { name: "Confirm ending the day" });
    await expect(confirm).toContainText("Ending the day exits 1 open practice trade at the price you see now: LRCX");
    await confirm.getByRole("button", { name: PRACTICE_COPY.dayEndYes }).click();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expectCleanScreen(page);
  });

  /** LRCX long (no stop), then TSLA long with a stop 3 dollars under the entry, then back on LRCX one bar on: TSLA's stop is crossed while she is on LRCX. */
  async function crossTslaStop(page: Page, context: BrowserContext) {
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /LRCX/ }).getByText("LRCX", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");
    await openName(page, dayUrl, "TSLA");
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");
    await (await replayRail(page, "Practice")).getByRole("button", { name: "Set stop" }).click();
    const stop = page.getByRole("form", { name: "Stop" });
    await stop.getByRole("textbox").fill("372");
    await stop.getByRole("button", { name: "Save" }).click();
    await expect(await marks(page)).toContainText("Practice stop");
    await openName(page, dayUrl, "LRCX");
    await stepBar(page);
    return dayUrl;
  }

  test("a stop crossed on another name pauses play, floats its row to the top as Stop crossed · Exit, and the row's Exit books the exit", async ({ page, context }) => {
    test.setTimeout(240_000);
    await crossTslaStop(page, context);

    // Play paused on LRCX's chart, and the toast names TSLA's stop.
    const toast = page.getByRole("alert").filter({ hasText: "TSLA crossed your stop 372.00" });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Exit TSLA" })).toBeVisible();

    // On the Portfolio tab, TSLA opened after LRCX, but a crossed stop comes first.
    const portfolio = await portfolioPanel(page);
    const rows = portfolio.locator("li[data-symbol]");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-symbol", "TSLA");
    await expect(rows.first()).toContainText(/Stop crossed \d{2}:\d{2}/);
    await expect(rows.last()).toHaveAttribute("data-symbol", "LRCX");
    await expect(rows.last()).not.toContainText("Stop crossed");

    // Exit from the row: TSLA goes flat, and LRCX's chart opens with no pause left to answer.
    await rows.first().getByRole("button", { name: "Exit TSLA" }).click();
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("Flat");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).not.toContainText("Stop crossed");
    await expect(portfolio.getByTestId("portfolio-total")).toContainText("1 open");
    await openFromPortfolio(page, "LRCX");
    await expect(toast).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("the day's stop-pause toast exits the paused name through its own session, and the exit counts as honoring the stop", async ({ page, context }) => {
    test.setTimeout(240_000);
    await crossTslaStop(page, context);

    const toast = page.getByRole("alert").filter({ hasText: "TSLA crossed your stop 372.00" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Exit TSLA" }).click();
    // Exit opens TSLA's session at the clock and books the exit there.
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(await marks(page)).toContainText("Practice exit");
    await expect(page.getByRole("alert").filter({ hasText: "TSLA crossed your stop" })).toHaveCount(0);
    const portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("Flat");
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText(/Long \d+ @ \$/);
    await expectCleanScreen(page);
  });

  test("a re-scan shows its progress, repopulates the list instead of adding a second one, and is labelled with its clock", async ({ page, context }) => {
    test.setTimeout(240_000);
    // The Desk recorded that morning with two of the stub's four names: the list scans those, and says so.
    await recordUniverse(context, [{ day: DAY, symbols: ["TSLA", "LRCX"] }]);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    const list = page.getByRole("table", { name: "Candidates" });
    await expect(list.getByRole("row", { name: /TSLA/ })).toBeVisible();
    await expect(list.getByRole("row", { name: /LRCX/ })).toBeVisible();
    await expect(list.getByRole("row", { name: /PANW|XOM/ })).toHaveCount(0);
    await expect(page.getByText(/the 2 symbols the Desk scanned that morning, as recorded/)).toBeVisible();

    // No name practiced yet, so no day clock: the button waits and says why.
    const rescan = page.getByRole("button", { name: PRACTICE_COPY.dayRescan });
    await expect(rescan).toBeDisabled();
    await expect(page.getByText(PRACTICE_COPY.dayRescanNeedsClock)).toBeVisible();

    // Practice TSLA five bars in (the clock reads 9:35), come back, and scan.
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page, 5);
    await expect(playhead(page)).toContainText("9:35");
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await expect(rescan).toBeEnabled();

    // The stub scans in a blink, so hold the day list's job at what a slow scan looks like: the test moves it on by hand.
    // Every other part of each answer (the list, the scan row, the counts) is the server's own.
    let stage: "counting" | "reading" | "filtering" | "live" = "counting";
    await page.route(/\/api\/desk\/replay\/day-lists\/\d+$/, async (route) => {
      if (route.request().method() !== "GET" || stage === "live") return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      if (body.rescan_job === null) return route.fulfill({ response, json: body });
      const progress = { counting: { done: 0, total: 0 }, reading: { done: 40, total: 134 }, filtering: { done: 134, total: 134 } }[stage];
      return route.fulfill({ response, json: { ...body, rescan_job: { ...body.rescan_job, state: "running", ...progress } } });
    });
    await rescan.click();
    const progress = page.getByTestId("rescan-progress-text");
    const bar = page.getByRole("progressbar", { name: PRACTICE_COPY.dayRescanProgressLabel });
    await expect(progress).toHaveText("Re-scanning at 9:35 AM ET · counting the names to read…");
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayRescanning })).toBeDisabled();
    stage = "reading";
    await expect(progress).toHaveText("Re-scanning at 9:35 AM ET · read 40 of 134 names (29%)");
    await expect(bar).toHaveAttribute("value", "40");
    await expect(bar).toHaveAttribute("max", "134");
    stage = "filtering";
    await expect(progress).toHaveText("Re-scanning at 9:35 AM ET · applying your filters to 134 names…");
    await expect(page.getByTestId("rescan-done")).toHaveCount(0); // still running: no "finished" yet
    stage = "live"; // the server's own answer: the scan is done
    await expect(page.getByTestId("rescan-done")).toHaveText("Re-scan finished · the list above is scan 1");
    await expect(progress).toHaveCount(0);
    await expect(rescan).toBeDisabled(); // the list already shows a scan at this clock
    await expect(page.getByTestId("rescan-hint")).toHaveText(PRACTICE_COPY.dayRescanCurrent);

    // The scan IS the list: its label sits with the list's counts, and there is no second table beside it.
    const label = page.getByTestId("rescan-label");
    await expect(label).toHaveText("Scan 1 · run at 9:35 AM ET · data through 9:20 AM");
    await expect(page.getByTestId("rescan-counts")).toHaveText("2 of 2 matched · 0 new in this scan");
    await expect(label).not.toContainText("2026"); // dates stay hidden
    await expect(page.getByRole("table", { name: "Re-scan" })).toHaveCount(0);
    await expect(list.getByRole("row")).toHaveCount(3); // the header and its two names
    await expect(list.getByRole("row", { name: /TSLA/ })).toHaveCount(1);
    await expect(list.getByRole("row", { name: /LRCX/ })).toHaveCount(1);
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);
    await expectCleanScreen(page);

    // The clock moves on: the scan says it is older, and a new scan replaces the list, it does not add to it.
    await page.getByRole("button", { name: "Switch to TSLA" }).first().click(); // the name in hand: its button reads Switch
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page);
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:37");
    await backToDayList(page);
    await page.waitForURL(dayUrl);
    await expect(page.getByTestId("rescan-stale")).toContainText("The day clock is now 9:37 AM ET · this scan is older");
    await expect(rescan).toBeEnabled();
    await rescan.click();
    await expect(label).toHaveText("Scan 2 · run at 9:37 AM ET · data through 9:22 AM");
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Re-scan" })).toHaveCount(0);
    await expect(list.getByRole("row")).toHaveCount(3); // still the header and its two names, not four
    await expect(list.getByRole("row", { name: /TSLA/ })).toHaveCount(1);
    await expect(list.getByRole("row", { name: /LRCX/ })).toHaveCount(1);
    await expect(page.getByTestId("rescan-counts")).toHaveText("2 of 2 matched · 0 new in this scan");

    // Ending the day closes scanning and keeps the last scan's label on screen.
    await endDayFromSummary(page);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayRescan })).toHaveCount(0);
    await expect(label).toHaveText("Scan 2 · run at 9:37 AM ET · data through 9:22 AM");
    await expectCleanScreen(page);
  });

  test("the New plan modal starts on the first recorded morning once 20 finished days are recorded, and says why", async ({ page, context }) => {
    let dialog = await openNewPlan(page);
    let firstDay = dialog.locator('input[type="date"]');
    let note = dialog.getByTestId("first-day-note");

    // Nothing recorded yet: the usual start, three months back.
    await expect(note).toHaveText("The Desk has not recorded a morning's universe yet · the default start is three months back");
    await expect(firstDay).not.toHaveValue(DAY);

    // The Desk has recorded 20 finished days since Fri 2026-09-18 (the E2E clock is Thu 2026-10-15 after the close): a new plan
    // starts on it, unless she picks a day.
    await recordUniverse(context, [{ day: FIRST_RECORDED, symbols: ["TSLA"] }]);
    dialog = await openNewPlan(page);
    firstDay = dialog.locator('input[type="date"]');
    note = dialog.getByTestId("first-day-note");
    await expect(note).toHaveText("The first day the Desk recorded its universe · 20 finished days of it exist");
    await expect(firstDay).toHaveValue(FIRST_RECORDED);
    await firstDay.fill("2026-09-28");
    await expect(firstDay).toHaveValue("2026-09-28");
    await expectCleanScreen(page);
  });
});
