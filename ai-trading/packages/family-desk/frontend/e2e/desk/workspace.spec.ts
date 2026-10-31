import type { Locator, Page } from "@playwright/test";
import { COPY, notEnoughHistoryText } from "../../lib/desk/freshness.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";

// D3 chart workspace and D4 technical summary on one route (`/technicals`, `#chart` or `#summary`), plus the
// D12 1180 behaviour of its right rail. Every test starts from the `technical` seed; the alert test re-seeds.

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

/** At 1180 the right rail is a tab strip and its sections open as a drawer; at 1440 the sections are always open. */
async function openRailSection(page: Page, name: "Summary" | "Alerts" | "Levels") {
  if (test.info().project.name !== "desktop-1180") return;
  await page.getByRole("tablist", { name: "Symbol context" }).getByRole("tab", { name }).click();
}

test("chart workspace shows the NVDA header, toolbar, chart legend and bottom panel", async ({ page }) => {
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  await expectCleanScreen(page);

  // Symbol header with the freshness line from the status table.
  await expect(page.getByRole("heading", { level: 1, name: "NVDA" })).toBeVisible();
  await expect(page.locator("#main-content").getByRole("status").filter({ hasText: COPY.closed })).toBeVisible();

  // Toolbar: seven timeframes with 15m pressed, Regular|Extended with Regular pressed, Indicators, + Alert.
  const timeframes = page.getByRole("group", { name: "Timeframe" });
  await expect(timeframes.getByRole("button")).toHaveText(["1m", "5m", "15m", "1h", "4h", "1D", "1W"]);
  await expect(timeframes.getByRole("button", { name: "15m", exact: true, pressed: true })).toBeVisible();
  const session = page.getByRole("group", { name: "Session" });
  await expect(session.getByRole("button", { name: "Regular", exact: true, pressed: true })).toBeVisible();
  await expect(session.getByRole("button", { name: "Extended", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Indicators", exact: true })).toBeVisible();
  // The rail repeats "+ Alert" for the symbol, so the toolbar's link is the one inside the content region.
  await expect(page.locator("#main-content").getByRole("link", { name: "+ Alert", exact: true })).toHaveAttribute("href", "/alerts/new?source=symbol:NVDA");

  // Chart: a canvas inside the labelled chart region, and the OHLC legend line for NVDA 15m.
  await expect(page.getByRole("region", { name: "NVDA 15m market chart" }).locator("canvas").first()).toBeVisible();
  await expect(page.locator("#main-content").getByText(/^NVDA · 15m · O /)).toBeVisible();

  // Bottom panel: Technicals (selected) · Signals · Levels.
  const panels = page.getByRole("region", { name: "Chart panels" }).getByRole("tablist", { name: "Panels" });
  await expect(panels.getByRole("tab")).toHaveText(["Technicals", "Signals", "Levels"]);
  await expect(panels.getByRole("tab", { name: "Technicals", selected: true })).toBeVisible();
});

test("the chart carries a dated as-of line with its source", async ({ page }) => {
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  await expect(page.locator("#main-content").getByText("As of last close · Thu 2026-10-15 · 3:45 PM ET · Alpaca", { exact: true })).toBeVisible();
  await expectCleanScreen(page);
});

test("the 1D timeframe requests its bars and technicals, presses 1D and relabels the legend", async ({ page }) => {
  const api = watchApi(page);
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  api.clear();

  await page.getByRole("group", { name: "Timeframe" }).getByRole("button", { name: "1D", exact: true }).click();
  await expect(page).toHaveURL(/timeframe=1d/);

  // One bars and one technicals request for the new timeframe.
  await expect.poll(() => api.paths().filter((path) => path.startsWith("GET /api/desk/bars/NVDA?") && path.includes("interval=1d")).length).toBe(1);
  await expect.poll(() => api.paths().filter((path) => path.startsWith("GET /api/desk/technicals/NVDA?") && path.includes("timeframe=1d")).length).toBe(1);
  await expect(page.getByRole("group", { name: "Timeframe" }).getByRole("button", { name: "1D", exact: true, pressed: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Timeframe" }).getByRole("button", { name: "15m", exact: true, pressed: true })).toHaveCount(0);
  await expect(page.locator("#main-content").getByText(/^NVDA · 1D · O /)).toBeVisible();
  await expectCleanScreen(page);
});

test("the Indicators menu lists the overlays and panes and adds SMA 50 to the legend", async ({ page }) => {
  await openDesk(page, "/technicals?symbol=NVDA#chart");

  await page.getByRole("button", { name: "Indicators", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Indicators" });
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(8);
  const sma50 = menu.getByRole("menuitemcheckbox", { name: "SMA 50", exact: true });
  await expect(sma50).toHaveAttribute("aria-checked", "false");
  await sma50.click();
  await expect(sma50).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // The overlay appears as a legend line with its value.
  await expect(page.locator("#main-content span").filter({ hasText: /^SMA 50$/ })).toBeVisible();
  await expectCleanScreen(page);
});

test("the 1D summary rates the gauges, lists oscillators, moving averages and pivots, and cites the footnote", async ({ page }) => {
  await openDesk(page, "/technicals?symbol=NVDA&timeframe=1d#summary");
  await expectCleanScreen(page);

  // 1D is selected and rated, so there is no warming-up banner.
  await expect(page.getByRole("tablist", { name: "Timeframe" }).getByRole("tab", { name: "1D", exact: true, selected: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Not enough history" })).toHaveCount(0);

  // Gauges: rating, score and vote counts in the image label; the summary has no per-vote counts.
  await expect(page.getByRole("img", { name: "Oscillators: Sell, score −0.27. Buy 0 · Neutral 8 · Sell 3" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Summary: Sell, score −0.47. Vote counts unavailable" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Moving averages: Strong Sell, score −0.67. Buy 2 · Neutral 1 · Sell 12" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Her strategies gauge" }).getByText("Attach a strategy to see its vote")).toBeVisible();

  // What changed, the indicator tables and the pivot table (Classic, Fibonacci, Camarilla; S3 to R3).
  await expect(page.locator("#main-content").getByText(/^Moved from Neutral to Sell at \d{1,2}:\d{2} [AP]M$/)).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Relative Strength Index (14)" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Hull MA (9)" })).toBeVisible();
  const pivots = page.getByRole("table", { name: "Pivot points by method, S3 to R3" });
  await expect(pivots.getByRole("columnheader")).toHaveText(["Level", "Classic", "Fibonacci", "Camarilla"]);
  await expect(pivots.getByRole("rowheader")).toHaveText(["S3", "S2", "S1", "P", "R1", "R2", "R3"]);

  // Footnote: the advice line and the method disclosure.
  await expect(page.getByText(COPY.advice, { exact: true })).toBeVisible();
  await expect(page.getByText("How Desk Technical Bias is computed")).toBeVisible();
});

test("intraday and 1W summaries warm up; each timeframe tab makes one technicals request", async ({ page }) => {
  const api = watchApi(page);
  await openDesk(page, "/technicals?symbol=NVDA#summary");
  const tabs = page.getByRole("tablist", { name: "Timeframe" });

  // 15m is the default and has too little history to rate; its gauges still render, in their warming state.
  await expect(page.getByRole("status").filter({ hasText: notEnoughHistoryText("15m") })).toBeVisible();
  await expect(page.getByRole("img", { name: "Summary: warming up, score —. Vote counts unavailable" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "15m", exact: true, selected: true })).toBeVisible();

  // Each tab fetches its own technicals once.
  const steps: Array<[label: string, value: string]> = [["5m", "5m"], ["30m", "30m"], ["1h", "1h"], ["4h", "4h"], ["1D", "1d"], ["1W", "1w"]];
  for (const [label, value] of steps) {
    api.clear();
    await tabs.getByRole("tab", { name: label, exact: true }).click();
    await expect(tabs.getByRole("tab", { name: label, exact: true, selected: true })).toBeVisible();
    await expect.poll(() => api.paths().filter((path) => path.startsWith("GET /api/desk/technicals/NVDA?") && path.includes(`timeframe=${value}`)).length).toBe(1);
  }

  // 1W has too little history too, and its gauges are still there in the warming state.
  await expect(page.getByRole("status").filter({ hasText: notEnoughHistoryText("1W") })).toBeVisible();
  await expect(page.getByRole("img", { name: "Summary: warming up, score —. Vote counts unavailable" })).toBeVisible();
  await expectCleanScreen(page);
});

test("the four alert fires show in the alerts list, the signals tab and the chart's marker feed", async ({ page, context }) => {
  await prepareDesk(context, "technical-alerts");
  // The fired-alert markers are drawn on the canvas, so the feed behind them is what the spec can read.
  const markers = page.waitForResponse((response) => response.url().includes("/api/desk/charts/NVDA/markers"));
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  const { fires } = (await (await markers).json()) as { fires: unknown[] };
  expect(fires).toHaveLength(4);

  // Alerts on NVDA lists the four fired strategies with their last fire time.
  await openRailSection(page, "Alerts");
  const alerts = page.getByRole("region", { name: "Alerts on NVDA" });
  await expect(alerts.getByRole("heading", { name: "Alerts on NVDA · 5" })).toBeVisible();
  await expect(alerts.getByRole("listitem").filter({ hasText: "Hammer 15m near S1" })).toContainText("2026-10-15 15:15");
  await expect(alerts.getByRole("listitem").filter({ hasText: "ORB 15m" })).toContainText("2026-10-15 10:02");
  await expect(alerts.getByRole("listitem").filter({ hasText: "Abnormal volume" })).toContainText("Never fired");
  await expectCleanScreen(page);
  if (test.info().project.name === "desktop-1180") await page.keyboard.press("Escape");

  // The Signals tab lists the same fires, newest first.
  await page.getByRole("region", { name: "Chart panels" }).getByRole("tab", { name: "Signals" }).click();
  const signals = page.getByRole("table", { name: "Signals" });
  await expect(signals.getByRole("row")).toHaveCount(5);
  await expect(signals.getByRole("row").nth(1)).toContainText("Hammer 15m near S1");
  await expect(signals.getByRole("row").nth(4)).toContainText("ORB 15m");
  await expectCleanScreen(page);
});

test("a symbol with no stored bars shows empty states, not errors", async ({ page }) => {
  // AMD has stored metrics on the watchlist but no bars: the chart says so, the quote line says unavailable.
  await openDesk(page, "/technicals?symbol=AMD#chart");
  await expectCleanScreen(page);
  await expect(page.getByRole("heading", { level: 1, name: "AMD" })).toBeVisible();
  await expect(page.locator("#main-content").getByRole("status").filter({ hasText: COPY.unavailable })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "No closed bars available for this symbol and timeframe." })).toBeVisible();
  await expect(page.getByText("Couldn't load this chart")).toHaveCount(0);

  // The summary of the same symbol reads unavailable, with no error block.
  await openDesk(page, "/technicals?symbol=AMD#summary");
  await expect(page.getByRole("img", { name: "Summary: Unavailable, score —. Vote counts unavailable" })).toBeVisible();
  await expect(page.getByText("Couldn't load this summary")).toHaveCount(0);
  await expectCleanScreen(page);
});

/** lightweight-charts lays a chart out as table rows: price pane, each indicator pane, then the time axis. */
function chartRows(chart: Locator) {
  return chart.locator("table").first().locator("tr").evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect()).filter((box) => box.height > 4).map((box) => ({ top: Math.round(box.top), height: Math.round(box.height) })));
}

async function settledRows(chart: Locator) {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await chartRows(chart));
    const settled = now === last && JSON.parse(now).length === 4;
    last = now;
    return settled;
  }).toBe(true);
  return JSON.parse(last) as Array<{ top: number; height: number }>;
}

test("the price pane keeps most of the chart and each pane legend sits on its pane (V-Technicals-04)", async ({ page }) => {
  test.skip(test.info().project.name === "desktop-1180", "the 1440 layout is the one measured in the audit");
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  const chart = page.getByRole("region", { name: "NVDA 15m market chart" });
  await expect(chart.locator("canvas").first()).toBeVisible();
  // Price, RSI and MACD: the price pane had 151 of about 380 px.
  await expect.poll(async () => {
    const panes = (await chartRows(chart)).slice(0, -1);
    const total = panes.reduce((sum, pane) => sum + pane.height, 0);
    return panes.length === 3 && total > 0 ? panes[0]!.height / total : 0;
  }).toBeGreaterThanOrEqual(0.58);
  const rows = await settledRows(chart);
  for (const [index, name] of [[1, "Close RSI (14)"], [2, "Close MACD (12, 26, 9)"]] as const) {
    const box = (await page.getByRole("button", { name }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(rows[index]!.top);
    expect(box.y + box.height).toBeLessThanOrEqual(rows[index]!.top + rows[index]!.height);
  }
});

test("the open data table leaves the chart as it was and reads in ET with one precision (V-Technicals-05)", async ({ page }) => {
  test.skip(test.info().project.name === "desktop-1180", "the 1440 layout is the one measured in the audit");
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  const chart = page.getByRole("region", { name: "NVDA 15m market chart" });
  await expect(chart.locator("canvas").first()).toBeVisible();
  const before = await settledRows(chart);
  const legend = (await page.getByRole("button", { name: "Close RSI (14)" }).boundingBox())!;

  await chart.getByText(/^Chart data table/).click();
  await expect(chart.getByRole("columnheader", { name: "Time (ET)" })).toBeVisible();
  await expect(chart.getByRole("rowheader").first()).toHaveText(/^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M$/);
  await expect(chart.getByRole("cell").first()).toHaveText(/^\d[\d,]*\.\d{2}$/);
  // The chart had fallen to 23 px with the RSI and MACD legends floating over the table rows.
  expect(await chartRows(chart)).toEqual(before);
  const tableOnTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("details") !== null, { x: legend.x + 4, y: legend.y + legend.height / 2 });
  expect(tableOnTop).toBe(true);
});

test("the right rail is open inline at 1440 and a drawer behind a 40 px strip at 1180", async ({ page }) => {
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  await expectCleanScreen(page);

  if (test.info().project.name === "desktop-1180") {
    // The strip lists the three sections; Summary opens a dialog, and Escape closes it and returns focus to the tab.
    const strip = page.getByRole("tablist", { name: "Symbol context" });
    await expect(strip.getByRole("tab")).toHaveText(["Summary", "Alerts", "Levels"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await strip.getByRole("tab", { name: "Summary" }).click();
    const drawer = page.getByRole("dialog", { name: "Summary" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Warming up on 15m")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(strip.getByRole("tab", { name: "Summary" })).toBeFocused();
  } else {
    // At 1440 the three sections stack in the 320 px rail with no strip and no drawer.
    const rail = page.getByRole("complementary", { name: "Symbol context" });
    await expect(rail.getByRole("region", { name: "Summary", exact: true }).getByText("Warming up on 15m")).toBeVisible();
    await expect(rail.getByRole("region", { name: "Alerts", exact: true })).toBeVisible();
    await expect(rail.getByRole("region", { name: "Levels", exact: true })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Symbol context" })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});
