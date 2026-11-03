import type { BrowserContext, Locator, Page } from "@playwright/test";
import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { stepBar } from "./clock-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { REPLAY_URL, THREAD_URL, expectNoDayLanguage, get, openLaneByApi, placeOrder, replayRail, saveFilter, send, startThread } from "./hub-helpers";
import { EVERY_NAME, backToScreen, openScreen } from "./lane-helpers";
import { positionCells, positionRow } from "./position-table";

// Switching names on the thread's one clock (02o-b2, ADR-0025). The stub holds TSLA on Fri 2026-09-25, and three stand-in names that
// replay TSLA's day at a fraction of its prices (`replay/fixture.py`), so one Screen holds four names. A name is a LANE of the thread: it is opened
// from the Screen or the Portfolio, never ended, and the thread's clock moves for all of them. Every lane replays 09:30 to 09:40 ET at 1-minute bars;
// `stepBar` moves the thread's server-side clock one bar (a chart has no Step).

const playhead = (page: Page) => page.getByTestId("thread-clock-time"); // the thread's one time, read-only text on every chart

/** The marks she has placed on the name on screen (the bottom panel is collapsed at 1180 until its tab opens). */
async function marks(page: Page) {
  await page.getByRole("tab", { name: "Marks" }).click();
  // A focused tab owns the arrow keys (ui/Tabs moves between tabs): hand the keyboard back to the page.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return page.getByRole("tabpanel");
}

/** The portfolio is the Portfolio tab's, never the chart view's (owner, 2026-11-01): open the tab from a chart and read it there. */
async function portfolioPanel(page: Page) {
  const region = page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle, exact: true });
  await expect(region, "a chart shows no portfolio").toHaveCount(0);
  await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: "Portfolio", exact: true }).click();
  await page.waitForURL(/\/practice\/thread\?id=\d+&tab=portfolio/);
  await expect(region).toBeVisible();
  return region;
}

/** A name's cells in the Portfolio tab's position table: each given column matches, once the table has read (the data lands a beat after the tab).
 *  The table lists only what is held now, so a name she exited has no row: assert that with `toHaveCount(0)` on `positionRow`, after a held row has shown the table read. */
async function expectPosition(
  portfolio: Locator,
  symbol: string,
  expected: { side?: RegExp | string; shares?: RegExp | string; price?: RegExp | string; avg?: RegExp | string; unrealized?: RegExp | string },
) {
  const columns = { side: "Side", shares: "Shares", price: "Price at thread time", avg: "Avg cost", unrealized: "Gain/loss" } as const;
  for (const [key, header] of Object.entries(columns) as [keyof typeof columns, string][]) {
    const want = expected[key];
    if (want === undefined) continue;
    await expect.poll(async () => (await positionCells(portfolio, symbol))[header] ?? "", { message: `${symbol}'s ${header}` }).toMatch(typeof want === "string" ? new RegExp(`^${want}$`) : want);
  }
}

/** From the Portfolio tab onto a name's chart, through its ticker (the tab's way into a chart). */
async function openFromPortfolio(page: Page, symbol: string) {
  await page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle, exact: true }).getByRole("link", { name: `Open ${symbol}` }).click();
  await page.waitForURL(REPLAY_URL);
  await expect(page.getByRole("heading", { name: symbol, level: 1 })).toBeVisible();
}

/** A thread started through the New thread modal on a filter that lists every name the stub has bars for, and its Screen scanned and open. */
async function startEveryNameThread(page: Page, context: BrowserContext) {
  await saveFilter(context, EVERY_NAME);
  const threadId = await startThread(page, context, { filter: EVERY_NAME.name });
  await openScreen(page, context, threadId);
  return { threadId, screenUrl: page.url() };
}

/** Opens a name from the Screen's table and lands on its chart. */
async function openName(page: Page, screenUrl: string, symbol: string) {
  await backToScreen(page);
  await page.waitForURL(screenUrl);
  await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: new RegExp(symbol) }).getByText(symbol, { exact: true }).click();
  await page.waitForURL(REPLAY_URL);
  await expect(page.getByRole("heading", { name: symbol, level: 1 })).toBeVisible();
}

test.describe("Practice: switching names", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a click opens a name at the thread clock, a name left behind catches up when opened, and every Screen name opens", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { screenUrl } = await startEveryNameThread(page, context);
    const table = page.getByRole("table", { name: "Candidates" });
    for (const symbol of ["TSLA", "LRCX", "PANW", "XOM"]) await expect(table.getByRole("row", { name: new RegExp(symbol) })).toBeVisible();

    // Stars are the Screen's own; there is no cap on names, and no name is open yet.
    await expect(page.locator("body")).not.toContainText(/names practiced today|limits a day|Starred \d+ of/);
    await expect(page.getByTestId("screen-lanes")).toHaveCount(0);
    await expectCleanScreen(page);

    // Click TSLA's row: its chart opens at once. Take it three bars in, and take a trade.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");
    const tslaPlayhead = (await playhead(page).textContent()) ?? "";
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");

    // The Portfolio tab shows it (the chart itself shows none): TSLA is Long. Its ticker leads back onto the chart.
    let portfolio = await portfolioPanel(page);
    await expectPosition(portfolio, "TSLA", { side: PRACTICE_COPY.portfolioSideLong, shares: /^\d[\d,]*$/, avg: /^[\d,]+\.\d{2}$/ }); // a long: unsigned shares, the average cost it was built at
    await openFromPortfolio(page, "TSLA");

    // Exit TSLA here; the next section opens LRCX at the clock TSLA reached. Holding several names at once has its own test below.
    await placeOrder(page, "Close position");
    await expect(await marks(page)).toContainText("Practice exit");

    // Opening LRCX takes the thread's time, not the start.
    await openName(page, screenUrl, "LRCX");
    await expect(playhead(page)).toHaveText(tslaPlayhead);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await stepBar(page);
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:35");
    const clock = (await playhead(page).textContent()) ?? "";
    await expectCleanScreen(page);

    // A new Long on LRCX joins the portfolio; TSLA, flat, is not a row (a closed trade is in Trades).
    await placeOrder(page, "Buy");
    portfolio = await portfolioPanel(page);
    await expectPosition(portfolio, "LRCX", { side: PRACTICE_COPY.portfolioSideLong, shares: /^\d[\d,]*$/, avg: /^[\d,]+\.\d{2}$/ });
    await expect(positionRow(portfolio, "TSLA")).toHaveCount(0);
    await openFromPortfolio(page, "LRCX");
    await placeOrder(page, "Close position");

    // TSLA stayed at 9:33 while the clock moved on: the Screen's list of opened names says its chart is behind. Opening it lifts it to the
    // thread's time (the server adds the away span), so it can be marked at once.
    await backToScreen(page);
    const lanes = page.getByTestId("screen-lanes");
    await expect(lanes.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.screenLaneBehind);
    await expect(lanes.locator('[data-symbol="LRCX"]')).not.toContainText(PRACTICE_COPY.screenLaneBehind);
    await lanes.getByRole("link", { name: "Open TSLA" }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(clock);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();
    await expectCleanScreen(page);
    await placeOrder(page, "Buy");
    await expect((await marks(page)).getByText("Practice buy")).toHaveCount(2); // the first trade and the one after the lift
    await placeOrder(page, "Close position");

    // A third and a fourth name open, and a name in hand switches back.
    await openName(page, screenUrl, "PANW");
    await openName(page, screenUrl, "XOM");
    await backToScreen(page);
    await page.waitForURL(screenUrl);
    await expect(page.locator("body")).not.toContainText(/names practiced today|allows \d+ names/);
    await expect(page.getByRole("row", { name: /LRCX/ }).getByRole("button", { name: "Open LRCX" })).toHaveText("Open"); // a name in hand reads Open like every other
    await expect(lanes.getByRole("listitem")).toHaveCount(4); // the four lanes she opened, none of them ended
    // The Screen is only the list of names: its portfolio is the Portfolio tab's, not a section of this screen.
    await expect(page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Screen context" }).getByRole("tab", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Resume/ })).toHaveCount(0);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("the thread's time is text on a chart, never a bar: no Play, Step, speed, Jump or Next open under or above any name, and the chart's own controls stay with the chart", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { screenUrl } = await startEveryNameThread(page, context);
    await openName(page, screenUrl, "TSLA");

    const readout = page.getByTestId("thread-time-readout");
    const slot = page.getByTestId("chart-slot");
    const toolbar = page.getByTestId("chart-toolbar");
    // The thread's time and whether it runs, as plain text with a way to the Summary: nothing to press but those links.
    await expect(readout).toBeVisible();
    await expect(readout.getByText(PRACTICE_COPY.threadTime, { exact: true })).toBeVisible();
    await expect(readout).toContainText("Paused");
    await expect(readout, "it names the thread, not one ticker").not.toContainText("TSLA");
    await expect(readout.getByRole("link", { name: PRACTICE_COPY.chartClockLink })).toBeVisible();
    await expect(readout.getByRole("button")).toHaveCount(0);
    // Play, Step, speed, Jump, Next open and the clock panel are not on the chart: not above it, not under it, not in the toolbar.
    await expect(page.getByTestId("thread-clock")).toHaveCount(0);
    for (const name of ["Play", "Pause", "Step", "Jump", "Next open"]) {
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
    const { screenUrl } = await startEveryNameThread(page, context);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    const tslaUrl = page.url();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");

    // LRCX opens at the thread's time and the clock moves on two bars; TSLA, off screen, stays where it was.
    await openName(page, screenUrl, "LRCX");
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
    await openName(page, screenUrl, "LRCX");
    await expect(playhead(page)).toContainText("9:36");
    await expectCleanScreen(page);
  });

  /** Money in a text as numbers: "+$1,204.50" is 1204.5 and "−$310.00" is -310. */
  const amounts = (text: string | null) =>
    [...(text ?? "").matchAll(/([+−-])?\$([\d,]+\.\d{2})/g)].map((found) => (found[1] === "+" || found[1] === undefined ? 1 : -1) * Number(found[2]!.replace(/,/g, "")));

  test("two names hold open positions at once: the Portfolio shows 2 open positions and their combined total, and a held name exits from its row", async ({ page, context }) => {
    test.setTimeout(240_000);
    const { threadId, screenUrl } = await startEveryNameThread(page, context);

    // Long TSLA three bars in, back to the Screen, open LRCX at the same clock and go Short: both positions stay open.
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");
    await openName(page, screenUrl, "LRCX");
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await placeOrder(page, "Sell");
    await expect(await marks(page)).toContainText("Practice sell");
    // Move the clock so both positions have a gain or loss worth adding up.
    await stepBar(page);
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:35");

    // The Portfolio holds both names, each with its side (signed shares: a short is negative), priced at the thread's time.
    const portfolio = await portfolioPanel(page);
    await expectPosition(portfolio, "TSLA", { side: PRACTICE_COPY.portfolioSideLong, shares: /^\d[\d,]*$/ });
    await expectPosition(portfolio, "LRCX", { side: PRACTICE_COPY.portfolioSideShort, shares: /^−\d[\d,]*$/ });
    await expect(positionRow(portfolio, "TSLA").getByRole("button", { name: "Exit TSLA" })).toBeVisible();
    await expect(positionRow(portfolio, "LRCX").getByRole("button", { name: "Exit LRCX" })).toBeVisible();
    const total = portfolio.getByTestId("portfolio-total");
    await expect(total).toContainText(PRACTICE_COPY.portfolioTotal);
    await expect(total).toContainText("priced at");
    // The head counts the open positions. Each row has the price at T, an average cost, a signed gain or loss and how long it has been held; there is
    // no Realized or Total column: a closed trade's result is in Trades.
    await expect(portfolio.getByTestId("portfolio-count")).toHaveText("2 open positions");
    const money = /^[+−]?\$[\d,]+\.\d{2}$/;
    for (const symbol of ["TSLA", "LRCX"]) {
      await expectPosition(portfolio, symbol, { price: /^[\d,]+\.\d{2}$/, avg: /^[\d,]+\.\d{2}$/, unrealized: money });
      const cells = await positionCells(portfolio, symbol);
      if ("Held for" in cells) expect(cells["Held for"], `${symbol}'s held-for time`).toMatch(/\S/);
      if ("Working orders" in cells) expect(cells["Working orders"], `${symbol} has no working order`).toBe("—");
    }
    // The footer is read from the server after the clock settles, so it can trail the rows by one read: wait for it to agree.
    await expect
      .poll(async () => {
        const rows = await Promise.all(["TSLA", "LRCX"].map(async (symbol) => (await positionCells(portfolio, symbol))["Gain/loss"]));
        const [headline] = amounts(await total.textContent());
        return Math.round(((headline ?? NaN) - rows.flatMap((text) => amounts(text ?? "")).reduce((sum, value) => sum + value, 0)) * 100);
      }, { message: "the Open P/L is the two rows added up" })
      .toBe(0);
    await expect(portfolio.getByText(PRACTICE_COPY.threadSimulated).first()).toBeVisible();
    await expect(portfolio.getByText(PRACTICE_COPY.portfolioPricedAt)).toBeVisible();
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // The Summary agrees: the same number of positions are open, and the account carries the same open P/L.
    const [open] = amounts(await total.textContent());
    await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: PRACTICE_COPY.tabSummary }).click();
    await page.waitForURL(THREAD_URL);
    await expect(page.getByTestId("thread-balance-open")).toContainText(/Open P\/L/);
    expect(amounts(await page.getByTestId("thread-balance-open").textContent())[0]).toBeCloseTo(open!, 1);
    await page.goBack(); // the Portfolio tab again
    await expect(portfolio).toBeVisible();

    // Exit TSLA from its row: it books its trade and leaves the Portfolio (the closed trade is in Trades, not here); one position is left open.
    await positionRow(portfolio, "TSLA").getByRole("button", { name: "Exit TSLA" }).click();
    await expect(positionRow(portfolio, "TSLA")).toHaveCount(0);
    await expectPosition(portfolio, "LRCX", { shares: /^−\d[\d,]*$/ });
    await expect(portfolio.locator("tbody tr")).toHaveCount(1);
    await expect(portfolio.getByTestId("portfolio-count")).toHaveText("1 open position");
    // The ledger holds the one closed trade: the thread's own read agrees with the Portfolio.
    expect(((await get(context, `/threads/${threadId}/ledger`)) as { entries: Array<{ symbol: string }> }).entries.map((entry) => entry.symbol)).toEqual(["TSLA"]);
    await openFromPortfolio(page, "LRCX");
  });

  /** LRCX long (no stop), then TSLA long with a stop 3 dollars under the entry, then back on LRCX two bars on: TSLA's stop is crossed while she is on LRCX. */
  async function crossTslaStop(page: Page, context: BrowserContext) {
    const { screenUrl } = await startEveryNameThread(page, context);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /LRCX/ }).getByText("LRCX", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    await stepBar(page, 3);
    await expect(playhead(page)).toContainText("9:33");
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");
    await openName(page, screenUrl, "TSLA");
    await placeOrder(page, "Buy");
    await expect(await marks(page)).toContainText("Practice buy");
    await (await replayRail(page, "Practice")).getByRole("button", { name: "Set stop" }).click();
    const stop = page.getByRole("form", { name: "Stop" });
    await stop.getByRole("textbox").fill("372");
    await stop.getByRole("button", { name: "Save" }).click();
    await expect(await marks(page)).toContainText("Practice stop");
    await openName(page, screenUrl, "LRCX");
    await stepBar(page, 2);
    return screenUrl;
  }

  test("a stop crossed on another name is an alert, not an exit: nothing pauses, the position stays open flagged Stop crossed, and the row's Exit books the exit", async ({ page, context }) => {
    test.setTimeout(240_000);
    await crossTslaStop(page, context);

    // Time did not stop and nothing was sold (ADR-0025): no toast on LRCX's chart, and the clock still moves.
    await expect(page.getByRole("alert").filter({ hasText: /crossed your stop/ })).toHaveCount(0);
    const before = (await playhead(page).textContent()) ?? "";
    await stepBar(page);
    await expect(playhead(page)).not.toHaveText(before);

    // On the Portfolio tab both positions are open, and TSLA's row carries the flag.
    const portfolio = await portfolioPanel(page);
    const rows = portfolio.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(positionRow(portfolio, "TSLA")).toContainText(/Stop crossed/);
    await expect(positionRow(portfolio, "LRCX")).not.toContainText("Stop crossed");
    await expect(portfolio.getByTestId("portfolio-count")).toHaveText("2 open positions");

    // The chart says the same on the position, and that it stays open.
    await openFromPortfolio(page, "TSLA");
    const practice = await replayRail(page, "Practice");
    await expect(practice.getByTestId("stop-crossed")).toContainText("the position stays open");
    await expect(practice.getByText(/^Long · \d+ shares/)).toBeVisible();

    // Exit from the row: TSLA leaves the Portfolio (it is closed), and LRCX stays open.
    await portfolioPanel(page);
    await positionRow(portfolio, "TSLA").getByRole("button", { name: "Exit TSLA" }).click();
    await expect(positionRow(portfolio, "TSLA")).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(portfolio.getByTestId("portfolio-count")).toHaveText("1 open position");
    await openFromPortfolio(page, "LRCX");
    await expectCleanScreen(page);
  });

  test("a scan shows its progress, repopulates the Screen instead of adding a second one, is labelled with the thread clock, and stops with the thread", async ({ page, context }) => {
    test.setTimeout(240_000);
    await saveFilter(context, EVERY_NAME);
    const threadId = await startThread(page, context, { filter: EVERY_NAME.name });
    const screenPage = `/practice/screen?thread=${threadId}`;

    // The thread's clock runs from its start, so the button needs no practiced name. A new Screen holds no names until its first scan.
    // Practice TSLA five bars in (the clock reads 9:35), come back, and scan.
    const lane = await openLaneByApi(context, threadId, "TSLA");
    await openDesk(page, `/practice/replay?id=${lane}`);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page, 5);
    await expect(playhead(page)).toContainText("9:35");
    await backToScreen(page);
    await expect(page.getByTestId("not-scanned")).toBeVisible();
    await expect(page.getByTestId("rescan-label")).toHaveText(PRACTICE_COPY.screenNotScanned);
    const scan = page.getByRole("button", { name: PRACTICE_COPY.screenScanNow });
    await expect(scan).toBeEnabled();

    // The stub scans in a blink, so hold the Screen's job at what a slow scan looks like: the test moves it on by hand.
    // Every other part of each answer (the names, the scan row, the counts) is the server's own.
    let stage: "counting" | "reading" | "filtering" | "live" = "counting";
    await page.route(/\/api\/desk\/replay\/threads\/\d+\/screen(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET" || stage === "live") return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      if (body.rescan_job === null) return route.fulfill({ response, json: body });
      const progress = { counting: { done: 0, total: 0 }, reading: { done: 40, total: 134 }, filtering: { done: 134, total: 134 } }[stage];
      return route.fulfill({ response, json: { ...body, rescan_job: { ...body.rescan_job, state: "running", ...progress } } });
    });
    await scan.click();
    const progress = page.getByTestId("rescan-progress-text");
    const bar = page.getByRole("progressbar", { name: PRACTICE_COPY.screenRescanProgressLabel });
    await expect(progress).toHaveText(practiceText("screenRescanCounting", { clock: "9:35 AM ET" }));
    await expect(page.getByRole("button", { name: PRACTICE_COPY.screenRescanning })).toBeDisabled();
    stage = "reading";
    await expect(progress).toHaveText(practiceText("screenRescanProgress", { clock: "9:35 AM ET", done: 40, total: 134, pct: 29 }));
    await expect(bar).toHaveAttribute("value", "40");
    await expect(bar).toHaveAttribute("max", "134");
    stage = "filtering";
    await expect(progress).toHaveText(practiceText("screenRescanFiltering", { clock: "9:35 AM ET", total: 134 }));
    await expect(page.getByTestId("rescan-done")).toHaveCount(0); // still running: no "finished" yet
    stage = "live"; // the server's own answer: the scan is done
    await expect(page.getByTestId("rescan-done")).toHaveText(practiceText("screenRescanDone", { seq: 1 }));
    await expect(progress).toHaveCount(0);
    const rescan = page.getByRole("button", { name: PRACTICE_COPY.screenRescanNow });
    await expect(rescan).toBeDisabled(); // the Screen already shows a scan at this clock
    await expect(page.getByTestId("rescan-hint")).toHaveText(PRACTICE_COPY.screenRescanCurrent);

    // The scan IS the Screen: its label sits with the counts, and there is no second table beside it.
    const label = page.getByTestId("rescan-label");
    await expect(label).toHaveText(practiceText("screenRescanLabel", { seq: 1, clock: "9:35 AM ET", through: "9:20 AM" }));
    // One scan time: the note and the status line say the scan's clock.
    await expect(page.getByTestId("live-note")).toContainText("9:35 AM ET scan");
    await expect(page.getByLabel("Status")).toContainText("Scanned 9:35 AM ET");
    await expect(page.getByLabel("Status")).not.toContainText(PRACTICE_COPY.screenNotScanned);
    await expect(page.getByTestId("rescan-counts")).toHaveText(/^\d+ of \d+ matched · \d+ new in this scan$/);
    await expect(page.getByRole("table", { name: "Re-scan" })).toHaveCount(0);
    const list = page.getByRole("table", { name: "Candidates" });
    const names = await list.getByRole("row").count();
    expect(names, "the header and the scanned names").toBeGreaterThan(1);
    await expect(list.getByRole("row", { name: /TSLA/ })).toHaveCount(1);
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // The clock moves on: the scan says it is older, and a new scan replaces the names, it does not add to them.
    await page.getByTestId("screen-lanes").getByRole("link", { name: "Open TSLA" }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await stepBar(page);
    await stepBar(page);
    await expect(playhead(page)).toContainText("9:37");
    await backToScreen(page);
    await expect(page.getByTestId("rescan-stale")).toContainText(practiceText("screenRescanStale", { clock: "9:37 AM ET" }));
    await expect(rescan).toBeEnabled();
    await rescan.click();
    await expect(label).toHaveText(practiceText("screenRescanLabel", { seq: 2, clock: "9:37 AM ET", through: "9:22 AM" }));
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Re-scan" })).toHaveCount(0);
    await expect(list.getByRole("row"), "still the header and the same names, not twice as many").toHaveCount(names);
    await expect(list.getByRole("row", { name: /TSLA/ })).toHaveCount(1);

    // Closing the thread stops scanning, keeps the last scan's label on screen, and leaves its positions alone.
    await send(context, "POST", `/threads/${threadId}/close`, {});
    await openDesk(page, screenPage);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.screenRescanNow })).toBeDisabled();
    await expect(page.getByTestId("rescan-hint")).toHaveText(PRACTICE_COPY.screenRescanClosed);
    await expect(label).toHaveText(practiceText("screenRescanLabel", { seq: 2, clock: "9:37 AM ET", through: "9:22 AM" }));
    await expectCleanScreen(page);
  });
});
