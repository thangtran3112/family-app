import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, prepareDesk, test } from "./helpers";
import { START_BUTTON, THREAD_URL, fillNewPlan, openFirstDay, openNewPlan, saveFilter, setRiskPlan, threadIdOf } from "./hub-helpers";

// Switching names on the shared day clock (02o-b2). The stub holds TSLA on Fri 2026-09-25, and three stand-in names that
// replay TSLA's day at a fraction of its prices (`replay/fixture.py`), so one daily list holds four names. Every session
// replays 09:30 to 09:40 ET at 1-minute bars; ArrowRight is one bar.

const DAY = "2026-09-25";
const FIRST_RECORDED = "2026-09-18"; // 20 finished sessions before the E2E clock
const SESSION_URL = /\/practice\/replay\?id=\d+/;

const playhead = (page: Page) => page.getByTestId("thread-clock-time"); // the thread's one clock, in the bar above every name

/** The marks she has placed on the name on screen (the bottom panel is collapsed at 1180 until its tab opens). */
async function marks(page: Page) {
  await page.getByRole("tab", { name: "Marks" }).click();
  // A focused tab owns the arrow keys (ui/Tabs moves between tabs): hand the keyboard back to the replay, whose → steps.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return page.getByRole("tabpanel");
}

/** The day's portfolio in the replay: the left rail at 1440, the right drawer's "Portfolio" tab at 1180. */
async function portfolioPanel(page: Page) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
  const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.dayPortfolio });
  if (!(await drawer.isVisible())) await page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** The day's portfolio on the day page: the left rail at 1440, the right drawer's "Portfolio" tab at 1180. */
async function dayPagePortfolio(page: Page) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: "Practice side panel" }).getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
  const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.dayPortfolio });
  if (!(await drawer.isVisible())) await page.getByRole("tablist", { name: "Day context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio }).click();
  await expect(drawer).toBeVisible();
  return drawer;
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
    for (let bar = 0; bar < 3; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:33");
    const tslaPlayhead = (await playhead(page).textContent()) ?? "";
    await page.keyboard.press("b");
    await expect(await marks(page)).toContainText("Practice buy");

    // The portfolio shows it: TSLA is on now and Long.
    let portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(/Long \d+ @ \$/);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayOnNow);

    // Exit TSLA here; the next section opens LRCX at the clock TSLA reached. Holding several names at once has its own test below.
    await page.keyboard.press("x");
    await expect(await marks(page)).toContainText("Practice exit");

    // Opening LRCX takes the clock TSLA reached, not the window start.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await table.getByRole("row", { name: /LRCX/ }).getByText("LRCX", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(tslaPlayhead);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");
    const clock = (await playhead(page).textContent()) ?? "";
    await expectCleanScreen(page);

    // A new Long on LRCX joins the portfolio; TSLA's row stays a plain switch (no "Close LRCX first").
    await page.keyboard.press("b");
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText(/Long \d+ @ \$/);
    const tslaRow = portfolio.getByRole("button", { name: "Switch to TSLA" });
    await expect(tslaRow).not.toHaveAttribute("aria-disabled", "true");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).not.toContainText(/Close LRCX first/);
    await page.keyboard.press("x");
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText("Flat");
    await expect(tslaRow).not.toHaveAttribute("aria-disabled", "true");

    // TSLA stayed at 9:33 while the clock moved on: its row says it is behind. Switching to it lifts it to the day clock (the
    // server adds the away span), so it can be marked at once.
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayBehind);
    await expect(portfolio.locator("li")).toHaveCount(2);
    await portfolio.getByRole("button", { name: "Switch to TSLA" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(clock);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();
    await expectCleanScreen(page);
    await page.keyboard.press("b");
    await expect((await marks(page)).getByText("Practice buy")).toHaveCount(2); // the first trade and the one after the lift
    await page.keyboard.press("x");

    // Past the old two-name limit: a third and a fourth name open, and a name in hand switches back.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /PANW/ }).getByRole("button", { name: "Open PANW" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "PANW", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /XOM/ }).getByText("XOM", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "XOM", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(page.locator("body")).not.toContainText(/names practiced today|allows \d+ names/);
    await expect(page.getByRole("row", { name: /LRCX/ }).getByRole("button", { name: "Switch to LRCX" })).toHaveText("Switch"); // a name in hand switches back
    const dayPortfolio = await dayPagePortfolio(page);
    await expect(dayPortfolio.locator("li")).toHaveCount(4);
    await expect(dayPortfolio.getByTestId("portfolio-total")).toContainText(PRACTICE_COPY.dayPortfolioTotal);
    // Resume is the day's, never a name's: no per-name button says Resume, and the header resumes the whole day on its shared clock.
    await expect(page.getByRole("button", { name: /^Resume/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Resume Day \d+$/ })).toBeVisible();
    await expectCleanScreen(page);

    // The whole day ends together: every opened name scores.
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("the clock is the thread's: one bar above every name, never under a chart, and a chart's own controls stay with the chart", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();

    const bar = page.getByTestId("thread-clock");
    const slot = page.getByTestId("chart-slot");
    const toolbar = page.getByTestId("chart-toolbar");
    await expect(bar).toBeVisible();
    await expect(bar.getByText(PRACTICE_COPY.threadTime, { exact: true })).toBeVisible();
    // Play, Step, speed and Jump are the thread's...
    await expect(bar.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Step", exact: true })).toBeVisible();
    await expect(bar.getByRole("group", { name: "Replay speed" })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Jump/ })).toBeVisible();
    await expect(bar.getByText(/^Paused at /)).toBeVisible();
    await expect(bar, "the bar names the thread, not one ticker").not.toContainText("TSLA");
    for (const name of ["Play", "Step", "Jump"]) {
      await expect(toolbar.getByRole("button", { name: new RegExp(`^${name}`) }), `${name} is not a chart control`).toHaveCount(0);
      await expect(slot.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveCount(0);
    }
    await expect(toolbar.getByRole("group", { name: "Replay speed" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 }).locator("xpath=ancestor::div[1]")).not.toContainText(/Paused|Playing/);
    // ...and the interval, Chart settings and Full screen are the chart's.
    await expect(toolbar.getByRole("group", { name: "Chart interval" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^Chart/ })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Full screen" })).toBeVisible();
    await expect(bar.getByRole("group", { name: "Chart interval" })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: /^Chart/ })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Full screen" })).toHaveCount(0);

    // Placement: the clock is above the name's header and chart; the chart's controls are under the chart.
    const box = async (locator: typeof bar) => (await locator.boundingBox())!;
    const [barBox, titleBox, slotBox, toolbarBox] = [await box(bar), await box(page.getByRole("heading", { name: "TSLA", level: 1 })), await box(slot), await box(toolbar)];
    expect(barBox.y + barBox.height, "the thread bar ends above the ticker header").toBeLessThanOrEqual(titleBox.y);
    expect(slotBox.y + slotBox.height, "the chart toolbar sits under the chart").toBeLessThanOrEqual(toolbarBox.y + 1);
    expect(barBox.y, "the thread bar is above the chart").toBeLessThan(slotBox.y);

    // The Jump panel opens downward from the top bar's button and stays inside the window.
    const jump = bar.getByRole("button", { name: /^Jump/ });
    const jumpBox = await box(jump);
    await jump.click();
    const menu = page.getByRole("dialog", { name: "Jump forward" });
    await expect(menu).toBeVisible();
    const menuBox = await box(menu);
    expect(menuBox.y, "the menu hangs below the Jump button").toBeGreaterThanOrEqual(jumpBox.y + jumpBox.height - 1);
    expect(menuBox.y + menuBox.height, "the menu stays inside the window").toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press("Escape");
    await expectCleanScreen(page);
  });

  test("Step moves the thread's one clock: a name left behind shows the thread's time and steps from it", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    const tslaUrl = page.url();
    for (let bar = 0; bar < 3; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:33");

    // LRCX opens at the thread's time and moves it on two bars; TSLA stays where it was.
    await openName(page, dayUrl, "LRCX");
    await expect(playhead(page)).toContainText("9:33");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");

    // TSLA, opened again from its own address, is behind: the bar still shows the thread's time, 9:35, not TSLA's 9:33.
    await page.goto(tslaUrl);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByTestId("behind-clock")).toBeVisible();
    await expect(playhead(page)).toContainText("9:35");
    await expect(page.getByTestId("thread-clock").getByText(/^Paused at 9:35 AM/)).toBeVisible();
    await expect(page.locator(".dk-status"), "the status bar reads the thread's clock too").toContainText("Replay clock 9:35");
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeDisabled();

    // One Step is one bar of the thread's clock (9:36), not the catch-up to 9:35 that leaves the time where it was.
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:36");
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();

    // The other name opens at that one time.
    await openName(page, dayUrl, "LRCX");
    await expect(playhead(page)).toContainText("9:36");
    await expectCleanScreen(page);
  });

  /** Money in a text as numbers: "+$1,204.50" is 1204.5 and "−$310.00" is -310. */
  const amounts = (text: string | null) =>
    [...(text ?? "").matchAll(/([+−-])?\$([\d,]+\.\d{2})/g)].map((found) => (found[1] === "+" || found[1] === undefined ? 1 : -1) * Number(found[2]!.replace(/,/g, "")));

  /** Opens a name from the day list's table and lands on its replay. */
  async function openName(page: Page, dayUrl: string, symbol: string) {
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
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
    for (let bar = 0; bar < 3; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:33");
    await page.keyboard.press("b");
    await expect(await marks(page)).toContainText("Practice buy");
    await openName(page, dayUrl, "LRCX");
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await page.keyboard.press("s");
    await expect(await marks(page)).toContainText("Practice sell");
    // Move the clock so both trades have a P/L worth adding up.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");

    // The Portfolio holds both names, each with its side, and its footer says how many are open and the combined total.
    let portfolio = await portfolioPanel(page);
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
    await page.goBack();
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    portfolio = await portfolioPanel(page);

    // Exit TSLA without leaving LRCX's chart: the row goes flat, books its trade, and one trade is left open.
    await portfolio.locator('[data-symbol="TSLA"]').getByRole("button", { name: "Exit TSLA" }).click();
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("Flat");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("1 trade");
    await expect(portfolio.getByTestId("portfolio-total")).toContainText("1 open");
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();

    // The day page asks before it exits what is still open, and names it.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
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
    for (let bar = 0; bar < 3; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:33");
    await page.keyboard.press("b");
    await expect(await marks(page)).toContainText("Practice buy");
    await openName(page, dayUrl, "TSLA");
    await page.keyboard.press("b");
    await expect(await marks(page)).toContainText("Practice buy");
    await page.keyboard.press("t");
    const stop = page.getByRole("form", { name: "Stop" });
    await stop.getByRole("textbox").fill("372");
    await stop.getByRole("button", { name: "Save" }).click();
    await expect(await marks(page)).toContainText("Practice stop");
    await openName(page, dayUrl, "LRCX");
    await page.keyboard.press("ArrowRight");
    return dayUrl;
  }

  test("a stop crossed on another name pauses play, floats its row to the top as Stop crossed · Exit, and the row's Exit books the exit", async ({ page, context }) => {
    test.setTimeout(240_000);
    await crossTslaStop(page, context);

    // Play paused on LRCX's chart, and the toast names TSLA's stop.
    const toast = page.getByRole("alert").filter({ hasText: "TSLA crossed your stop 372.00" });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Exit TSLA" })).toBeVisible();

    // TSLA opened after LRCX, but a crossed stop comes first.
    let portfolio = await portfolioPanel(page);
    const rows = portfolio.locator("li[data-symbol]");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-symbol", "TSLA");
    await expect(rows.first()).toContainText(/Stop crossed \d{2}:\d{2}/);
    await expect(rows.last()).toHaveAttribute("data-symbol", "LRCX");
    await expect(rows.last()).not.toContainText("Stop crossed");

    // Exit from the row: she stays on LRCX, TSLA goes flat, and the pause is answered.
    await rows.first().getByRole("button", { name: "Exit TSLA" }).click();
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("Flat");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).not.toContainText("Stop crossed");
    await expect(portfolio.getByTestId("portfolio-total")).toContainText("1 open");
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
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

  test("a re-scan runs at the day clock, says when and on what data, and leaves the list as it was", async ({ page, context }) => {
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
    for (let bar = 0; bar < 5; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(rescan).toBeEnabled();
    await rescan.click();
    const label = page.getByTestId("rescan-label");
    await expect(label).toHaveText("Scan 1 · run at 9:35 AM ET · data through 9:20 AM");
    await expect(page.getByTestId("rescan-counts")).toHaveText("2 of 2 matched · 0 new since your list");
    await expect(label).not.toContainText("2026"); // dates stay hidden
    const scanned = page.getByRole("table", { name: "Re-scan" });
    await expect(scanned.getByRole("row", { name: /TSLA/ })).toBeVisible();
    await expect(scanned.getByRole("row", { name: /LRCX/ })).toBeVisible();
    await expect(list.getByRole("row")).toHaveCount(3); // the frozen list is unchanged: header and its two names
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);
    await expectCleanScreen(page);

    // The clock moves on: the old scan says it is older, and a new scan is its own.
    await page.getByRole("button", { name: "Switch to TSLA" }).first().click(); // the name in hand: its button reads Switch
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:37");
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(page.getByTestId("rescan-stale")).toContainText("The day clock is now 9:37 AM ET · this scan is older");
    await rescan.click();
    await expect(label).toHaveText("Scan 2 · run at 9:37 AM ET · data through 9:22 AM");
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);

    // Ending the day closes scanning and keeps the last scan on screen.
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
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
