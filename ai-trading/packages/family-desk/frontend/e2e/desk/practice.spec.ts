import type { BrowserContext, Page } from "@playwright/test";
import { formatEtDay } from "../../lib/desk/format.ts";
import { formatBalance } from "../../lib/replay/threadView.ts";
import { PRACTICE_COPY, practiceBandText, practiceText } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { stepBar } from "./clock-helpers";
import { brokenTileValues, expect, expectBacktestChrome, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";
import {
  DAY,
  ET_OFFSET,
  REPLAY_URL,
  START_BUTTON,
  THREAD_URL,
  clickNewPlan,
  clockByApi,
  createThreadByApi,
  discardNewPlan,
  expectNoDayLanguage,
  fillNewPlan,
  get,
  openLaneByApi,
  openNewPlan,
  openRow,
  placeOrder,
  playByApi,
  railSection,
  replayRail,
  saveFilter,
  send,
  startThread,
  watchAnswers,
} from "./hub-helpers";
import { backToScreen, openScreen, startLane } from "./lane-helpers";

// The Practice lane (02o §i, step 5; ADR-0025): the landing and its New thread modal start a freestyle thread; a name is a lane of it, opened from the Screen;
// Buy, Set stop, Close position, the journal, and a reloaded lane follow the thread's one clock. Nothing ends: there is no day, no End day, no Skip day.
// The backend runs with `DESK_REPLAY_STUB=1` (`replay/fixture.py`): the one replayable day is TSLA on Fri 2026-09-25 and the tape holds its first ten
// minutes after the open, so every lane here replays 09:30 to 09:40 ET.

const LIVE_DATA = /\/api\/desk\/(bars|technicals|quotes|charts)\b/;
const playhead = (page: Page) => page.getByTestId("thread-clock-time"); // the thread's time: read-only text on a chart
const marksTab = (page: Page) => page.getByRole("tab", { name: "Marks" });
/** Opens the Marks tab and hands the keyboard back to the page: a focused tab owns the arrow keys (ui/Tabs). */
const openMarks = async (page: Page) => {
  await marksTab(page).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
};

/** The landing's row for the first thread (the table of her threads). */
const threadRow = (page: Page) => page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel }).locator("tbody tr").first();

/** A thread answered by the API: the numbers the screens must agree with. */
async function readThread(context: BrowserContext, id: number) {
  return (await get(context, `/threads/${id}`)) as {
    thread: { id: number; startingBalance: number; shares?: number; status: string; stats: { balance: number; wins: number; losses: number } };
    daily: Array<{ n: number; day: string; trades: number; pnl_usd: number; balance: number }>;
    curve: Array<{ n: number; balance: number }>;
  };
}

/** A thread made through the API, its Screen scanned at the thread's start and open. Returns the thread's id. */
async function openScreenPage(page: Page, context: BrowserContext, thread: Parameters<typeof createThreadByApi>[1] = {}): Promise<number> {
  const threadId = await createThreadByApi(context, thread);
  await openScreen(page, context, threadId);
  return threadId;
}

test.describe("Practice", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the landing shows the Practice band, and a lane opens on its replay screen without reading the live store", async ({ page, context }) => {
    const api = watchApi(page);
    await openDesk(page, "/practice");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(null));
    await expect(page.getByRole("heading", { name: "Practice", level: 1 })).toBeVisible();
    // ADR-0014: Practice is Backtest mode, with no live-market chrome.
    await expectBacktestChrome(page, "Practice");
    await expectCleanScreen(page);

    expect((await page.request.get(`${origin}/favicon.ico`)).ok(), "D-010: the export ships a favicon").toBeTruthy();

    await startLane(page, context);
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expectBacktestChrome(page, "Practice");
    await expectCleanScreen(page);
    expect(api.paths().filter((path) => LIVE_DATA.test(path)), "a replay screen never reads the live store").toEqual([]);
  });

  test("arming a saved alert strategy in the thread's setup opens a lane that lists it", async ({ page, context }) => {
    const strategies = (await (await context.request.get(`${origin}/api/desk/alert-strategies`)).json()) as Array<{ id: number; name: string }>;
    const orb = strategies.find((row) => row.name === "ORB 15m");
    expect(orb, "the seed ships ORB 15m").toBeDefined();
    const filterId = await saveFilter(context);
    const threadId = await createThreadByApi(context, { filterId });
    // A later setup replaces the plan and the Screen's filters and never moves time.
    await send(context, "PUT", `/threads/${threadId}/setup`, {
      schemaVersion: 2,
      startAt: `${DAY}T09:30:00${ET_OFFSET}`,
      screen: { filters: [{ id: filterId }], maxList: 30 },
      setup: { interval: "1m", session: "regular", armed: [{ source: "alert_strategy", id: orb!.id }] },
    });
    const lane = await openLaneByApi(context, threadId);
    await openDesk(page, `/practice/replay?id=${lane}`);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    // The armed list lives in the left rail (1440) or its collapsed strip (1180); the lane itself says what it armed.
    const body = (await get(context, `/sessions/${lane}`)) as { armed: Array<{ name: string; fires_so_far: number }> };
    expect(body.armed.map((item) => item.name)).toEqual(["ORB 15m"]);
    await expectCleanScreen(page);
  });

  test("a lane shows its date: the band, the header and the clock name Fri 2026-09-25 (ADR-0022)", async ({ page, context }) => {
    await startLane(page, context);
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expect(page.locator("body")).toContainText(formatEtDay(DAY));
    await expect(page.locator("body")).not.toContainText(/hidden day|show date/i);
    await expectCleanScreen(page);
  });

  test("a name with no stored trades is refused in plain words instead of opening a lane", async ({ context }) => {
    const threadId = await createThreadByApi(context);
    const refused = await context.request.post(`${origin}/api/desk/replay/threads/${threadId}/lanes`, { data: { symbol: "NVDA" } });
    expect(refused.ok()).toBeFalsy();
    expect(refused.status()).toBeLessThan(500);
    expect(JSON.stringify(await refused.json())).not.toContain("Traceback");
    expect(((await get(context, `/threads/${threadId}/screen`)) as { lanes: unknown[] }).lanes.length, "nothing was opened").toBe(0);
  });

  test("the thread's clock moves a lane: Play runs it, Pause stops it, one bar moves it one bar, and Practice has no keyboard shortcuts", async ({ page, context }) => {
    const answers = watchAnswers(page);
    const { threadId } = await startLane(page, context);
    const clock = playhead(page);
    const readout = page.getByTestId("thread-time-readout");
    await expect(clock).toContainText("9:30");

    // The clock runs on the server: 10x and Play are what the Summary's buttons send. The chart follows it and only ever moves forward.
    await playByApi(context, threadId, 10);
    await expect(readout).toContainText(practiceText("clockStateRunning", { speed: 10 }));
    // D-024: the tape has its BIG column and names the pace window.
    await expect(page.getByRole("columnheader", { name: "Big" })).toBeVisible();
    await expect(page.getByText("Pace · 10 seconds")).toBeVisible();
    await expect(clock).not.toContainText("9:30:00", { timeout: 10_000 });
    await clockByApi(context, threadId, { running: false });
    await expect(readout).toContainText(PRACTICE_COPY.clockStatePaused);

    const before = await clock.innerText();
    await stepBar(page);
    await expect(clock).not.toHaveText(before);

    // D-036, D-025: the header's Practice P/L reads with its SIMULATED unit, beside VWAP and the prior close.
    await expect(page.getByTitle("Closed practice trades plus the open trade at the last price")).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(page.locator("dt", { hasText: "VWAP" })).toBeVisible();
    await expect(page.locator("dt", { hasText: "Prior close" })).toBeVisible();
    // D-043: the replay has its own status line, not the live-quotes one.
    await expect(page.getByLabel("Status")).toContainText("Prices: Alpaca SIP · replay");
    await expect(page.getByLabel("Status")).not.toContainText("Alerts start when live quotes are connected");
    // Owner, 2026-11-01: the tape sits under the indicators in the left rail at both bands, whether or not play ever opened a drawer.
    await expect(page.getByRole("complementary", { name: "Practice side panel" }).getByTestId("tape-panel").getByRole("table", { name: "Time and sales" })).toBeVisible();
    // D-020: at the 1180 band each tab opens its own drawer; one never closes another.
    if (test.info().project.name === "desktop-1180") {
      const tabs = page.getByRole("tablist", { name: "Replay context" });
      await expect(tabs.getByRole("tab")).toHaveText(["Practice", "Signals"]);
      await tabs.getByRole("tab", { name: "Signals" }).click();
      await tabs.getByRole("tab", { name: "Practice" }).click();
      await expect(tabs.getByRole("tab", { name: "Signals" })).toHaveAttribute("aria-selected", "true");
      await expect(tabs.getByRole("tab", { name: "Practice" })).toHaveAttribute("aria-selected", "true");
    }

    // Owner, 2026-11-01: no shortcut legend on the chart, and ? opens no list of them.
    await expect(page.getByRole("group", { name: "Keyboard legend" })).toHaveCount(0);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expectCleanScreen(page);

    // Nothing the browser was told ever lies past the playhead it was told about (the owner's network-log check).
    expect(answers.length).toBeGreaterThan(0);
    for (const { path, body } of answers) {
      const through = body.revealed_through as string | undefined;
      if (!through) continue;
      const limit = Date.parse(through);
      for (const row of ((body.prints as { rows?: Array<[string, ...unknown[]]> } | undefined)?.rows ?? [])) {
        expect(Date.parse(row[0]), `${path}: a print after the playhead`).toBeLessThanOrEqual(limit);
      }
      for (const bar of (body.bars as Array<{ t: string }> | undefined) ?? []) {
        expect(Date.parse(bar.t) + 60_000, `${path}: a bar that has not closed`).toBeLessThanOrEqual(limit);
      }
      for (const signal of (body.signals as Array<{ bar_close: string }> | undefined) ?? []) {
        expect(Date.parse(signal.bar_close), `${path}: a signal that has not fired`).toBeLessThanOrEqual(limit);
      }
    }
  });

  test("Buy, Set stop and Close position place practice marks; nothing ends the lane, and its journal is read live with the trade", async ({ page, context }) => {
    const { sessionId } = await startLane(page, context);
    await stepBar(page, 2);

    // A practice long, priced at the replayed last price.
    await placeOrder(page, "Buy");
    await openMarks(page);
    const marks = page.getByRole("tabpanel");
    await expect(marks).toContainText("Practice buy");

    // Set stop opens the stop note; Save puts it on the position.
    await (await replayRail(page, "Practice")).getByRole("button", { name: "Set stop" }).click();
    const stop = page.getByRole("form", { name: "Stop" });
    await expect(stop).toBeVisible();
    await stop.getByRole("textbox").fill("180");
    await stop.getByRole("button", { name: "Save" }).click();
    await expect(marks).toContainText("Practice stop");

    // Close position exits the whole long.
    await placeOrder(page, "Close position");
    await expect(marks).toContainText("Practice exit");
    await expectCleanScreen(page);

    // A lane never ends: no End session, no score bar. Its journal is the live one, with the trade in it.
    await expect(page.getByRole("button", { name: /^End / })).toHaveCount(0);
    await openDesk(page, `/practice/journal?id=${sessionId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Practice journal");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA");
    await expect(page.getByRole("listitem").filter({ hasText: /^Trades/ })).toContainText("1");
    expect(await brokenTileValues(page), "a journal tile value wraps or spills (D-086)").toEqual([]);
    await expect(page.getByRole("table", { name: "Practice trades" }).getByRole("row")).toHaveCount(2); // header + the trade
    await expectCleanScreen(page);

    // Notes and the self-rating save through the one PATCH route.
    const details = await railSection(page, "Journal details", "Adherence");
    await details.getByLabel(PRACTICE_COPY.journalNotes).fill("Waited for the first pullback.");
    await details.getByRole("button", { name: "Save notes" }).click();
    await expect(details.getByText(PRACTICE_COPY.notesSaved)).toBeVisible();
    await details.getByRole("radio", { name: "4" }).click();
    await expect(details.getByRole("radio", { name: "4" })).toBeChecked();
  });

  test("a reloaded lane restores the thread's time", async ({ page, context }) => {
    await startLane(page, context);
    await stepBar(page, 2);
    const clock = playhead(page);
    await expect(clock).not.toContainText("9:30:00");
    const placed = await clock.innerText();

    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(placed);
    await expectCleanScreen(page);
  });

  // ADR-0025: a thread has one Screen. Her saved filters are scanned at the thread's time; Peek shows a name's chart before the open; a row click opens
  // its lane. The stub holds TSLA on Fri 2026-09-25 only, so the scan lists TSLA through her own always-matching daily filter.
  test("the Screen scans her filters at the thread's time with Peek, and a row click opens the name's lane", async ({ page, context }) => {
    test.setTimeout(180_000);
    const answers = watchAnswers(page);
    const api = watchApi(page);
    await saveFilter(context); // her own always-matching daily filter; TSLA only: the fixture's stand-in names trade below $200

    // The New thread modal starts the thread and its setup in one go; its risk plan (a $600 loss, at most 3 trades) is set on the thread.
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog);
    await expectCleanScreen(page);
    await expect(dialog.getByRole("button", { name: "Save plan" })).toHaveCount(0); // D-003: the button says what it does
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    const threadId = Number(new URL(page.url()).searchParams.get("id"));
    await send(context, "PATCH", `/threads/${threadId}`, { schemaVersion: 1, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no", maxLossUsd: 600, maxTrades: 3, planNote: "Trade only clean pullbacks." } });
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(formatBalance(50_000));
    await expect(page.getByTestId("thread-clock-time")).toContainText("9:30");
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    await openScreen(page, context, threadId);
    // The Screen: the dated title, the candidate, the universe line, and the footnote. The date is a label of the thread's time.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(practiceText("screenTitle", { day: formatEtDay(DAY) }));
    await expect(page.getByText(PRACTICE_COPY.screenBadge, { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expect(page.getByText(/Universe: today's Desk set, up to 250 names by today's dollar volume \(\d+ names here\)/).first()).toBeVisible();
    const table = page.getByRole("table", { name: "Candidates" });
    await expect(table.getByRole("row", { name: /TSLA/ })).toBeVisible();
    // The Screen has no left rail (the Practice side panel stays empty): the right rail holds the thread plan, at 1440 stacked and at 1180 a drawer tab.
    await expect(page.locator('aside[aria-label="Practice side panel"]')).toBeEmpty(); // zero width, so no role query sees it
    const plan = await railSection(page, "Screen context", PRACTICE_COPY.threadPlanTitle);
    await expect(plan).toContainText(/max loss \$600/);
    await expect(plan).toContainText(/up to 3 trades per ET date/);
    await expect(plan, "a stop is not asked for or scored").not.toContainText(/stop on every entry/i);
    if (test.info().project.name === "desktop-1180") await page.keyboard.press("Escape");
    await expect(page.getByRole("list", { name: "Filters" }).getByRole("listitem").first()).toHaveAttribute("data-active", "true");
    await expect(page.getByText(PRACTICE_COPY.screenFiltersNoteOne, { exact: true })).toBeVisible();
    for (const label of ["Prev close", "Prev RVOL", "Prev change %"]) await expect(table.getByRole("columnheader", { name: label, exact: true })).toBeVisible(); // exact: "vs prev close % now" is a column from the first paint (D-159)
    // D-136: no name reports before the open, so there is no Earnings column of dashes to scroll past.
    await expect(table.getByRole("columnheader", { name: "Earnings" })).toHaveCount(0);
    // D-043: the Screen's own status line. One scan time: the scan's clock.
    await expect(page.getByLabel("Status")).toContainText("Scanned 9:30 AM ET");
    await expect(page.getByLabel("Status")).toContainText(PRACTICE_COPY.statusScanAtClock);
    await expect(page.locator("body")).toContainText(formatEtDay(DAY));
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // Peek: the chart before the open, from the row's own button, in a wide drawer. It adds no lane and starts no clock.
    const peekButton = table.getByRole("row", { name: /TSLA/ }).getByRole("button", { name: "Peek at TSLA" });
    await peekButton.click();
    const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.screenPeek });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "TSLA", level: 3 })).toBeVisible();
    await expect(drawer.getByRole("tab", { name: PRACTICE_COPY.screenPeekToday })).toBeVisible(); // D-019: no "Today so far" on a replay
    await expect(page.getByText("Today so far")).toHaveCount(0);
    await expect(page.getByTestId("screen-lanes"), "Peek opens no lane").toHaveCount(0);
    await expectCleanScreen(page);
    // The drawer is wider than the 320 px rail it replaced, so the chart is readable; its levels are named in a legend in normal
    // flow above the plot (never printed over the candles), and no two entries touch.
    const chartBox = (await drawer.getByRole("region", { name: "TSLA 1m market chart" }).boundingBox())!;
    expect(chartBox.width, "the Peek chart is wider than the old 320 px rail").toBeGreaterThan(500);
    expect(chartBox.height, "the Peek chart is taller than the old 260 px").toBeGreaterThanOrEqual(380);
    const legend = drawer.getByTestId("peek-levels");
    await expect(legend).toContainText(PRACTICE_COPY.screenPeekLevels);
    await expect(legend).toContainText(PRACTICE_COPY.screenPeekPrice);
    const entries = await legend.locator(":scope > div > span").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }));
    expect(entries.length, "the scan price and at least one more level").toBeGreaterThanOrEqual(2);
    entries.forEach((a, i) => {
      expect(a.right, `legend entry ${i} stays inside the drawer`).toBeLessThanOrEqual(chartBox.x + chartBox.width + 1);
      expect(a.bottom, `legend entry ${i} sits above the plot, not over it`).toBeLessThanOrEqual(chartBox.y + 1);
      entries.slice(i + 1).forEach((b, j) => {
        const apart = a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        expect(apart, `legend entries ${i} and ${i + 1 + j} do not overlap`).toBe(true);
      });
    });
    // Escape closes it and hands focus back to the row's Peek button; the Close button does the same.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(peekButton).toBeFocused();
    await peekButton.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: PRACTICE_COPY.screenPeekClose }).first().click();
    await expect(drawer).toHaveCount(0);
    await expect(peekButton).toBeFocused();

    // Click the row: the lane opens at the thread's time, and the tab strip leads back.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /^End / }), "no End day on the chart, nor anywhere else (ADR-0025)").toHaveCount(0);
    // The chart is where orders are placed and no tab of the thread: the strip is there with Summary, Portfolio, Screen and Trades, and none is selected.
    const chartTabs = page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel });
    await expect(chartTabs.getByRole("tab")).toHaveText(["Summary", "Portfolio", "Screen", "Trades"]);
    await expect(chartTabs.locator('[role="tab"][aria-selected="true"]')).toHaveCount(0);
    // ADR-0022: the date always shows, on the band, the header and the clock.
    await expect(page.locator("body")).toContainText(formatEtDay(DAY));
    await stepBar(page);
    await expect(playhead(page)).not.toContainText("9:30:00");
    await expectCleanScreen(page);

    // The workspace carries the thread: its balance (SIMULATED). The left rail is the technical indicators.
    const strip = page.getByRole("group", { name: "Practice thread" });
    await expect(strip).toContainText("Thread balance $50,000");
    await expect(strip).toContainText(PRACTICE_COPY.threadSimulated);
    const side = page.getByRole("complementary", { name: "Practice side panel" });
    const indicators = side.getByTestId("indicators-panel");
    await expect(indicators.getByRole("heading", { name: PRACTICE_COPY.indicatorsTitle })).toBeVisible();
    for (const label of ["RSI (14)", "MACD (12, 26, 9)", "Signal", "Histogram", "VWAP", "EMA 9", "EMA 21"]) await expect(indicators).toContainText(label);
    for (const gone of ["Shares per trade", "Plan note:", "Armed strategies"]) await expect(side, `the old ${gone} block is gone`).not.toContainText(gone);

    // What the Screen was told never lies past its data time: the scan carries nothing later, and no review.
    const screens = answers.filter(({ path }) => /^\/threads\/\d+\/screen(\?|$)/.test(path));
    expect(screens.length).toBeGreaterThan(0);
    for (const { body } of screens) {
      const through = Date.parse(body.data_through as string);
      expect(body.review ?? null).toBeNull();
      for (const candidate of (body.candidates as Array<{ price_at: string; matched_since: string }>) ?? []) {
        expect(Date.parse(candidate.price_at)).toBeLessThanOrEqual(through);
        expect(Date.parse(candidate.matched_since)).toBeLessThanOrEqual(Date.parse(body.as_of as string));
      }
      const peek = body.peek as { minutes: Array<{ t: string }>; daily: Array<{ t: string }> } | null;
      for (const bar of peek?.minutes ?? []) expect(Date.parse(bar.t) + 60_000).toBeLessThanOrEqual(through);
      for (const bar of peek?.daily ?? []) expect(bar.t < DAY, "a daily bar of the date itself").toBe(true);
    }
    expect(api.paths().filter((path) => LIVE_DATA.test(path)), "the Practice screens never read the live store").toEqual([]);
  });

  test("a trade books to the thread: the ticket's cash rule, an optional stop, an exit that moves the balance; the Summary, the ledger and the journal agree", async ({ page, context }) => {
    test.setTimeout(180_000);
    const { threadId } = await startLane(page, context, { thread: { maxLoss: 600, maxTrades: 3, note: "Trade only clean pullbacks.", stop: true } });
    await stepBar(page);
    // The one size rule is the account's cash: a quantity the balance cannot cover (here far past 10,000 shares) is refused in the ticket before anything is sent, with its cost and the buying power, and nothing else limits a size.
    const practice = await replayRail(page, "Practice");
    await practice.getByRole("textbox", { name: "Quantity" }).fill("100000");
    await expect(practice.getByText(/^Exceeds buying power · this order costs \$[\d,]+, buying power is \$50,000$/)).toBeVisible();
    await expect(practice.getByRole("button", { name: "Buy" }), "Buy stays off while the order does not fit").toBeDisabled();
    await practice.getByRole("textbox", { name: "Quantity" }).fill("100");
    await expect(practice.getByText(/^Exceeds buying power/)).toHaveCount(0);
    // A stop is optional even when the thread plan asks for one: Buy places the entry, with no refusal and no warning.
    await practice.getByRole("button", { name: "Buy" }).click();
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Dismiss message" }) })).toHaveCount(0);
    // The 100 shares spent most of the cash, so another 100 would not fit and Buy says so; a size that fits is open again.
    await expect(practice.getByRole("button", { name: "Buy" })).toBeDisabled();
    await practice.getByRole("textbox", { name: "Quantity" }).fill("1");
    await expect(practice.getByRole("button", { name: "Buy" })).toBeEnabled();
    await expect(practice.getByRole("button", { name: "Buy" }), "no hint ties the buttons to a stop").not.toHaveAccessibleDescription(/stop/i);
    // Set stop on the open position afterwards; it is the same optional stop, typed in the stop form.
    await practice.getByRole("button", { name: "Set stop" }).click();
    const stopForm = practice.getByRole("form", { name: "Stop" });
    await stopForm.getByRole("textbox").fill("150");
    await stopForm.getByRole("button", { name: "Save" }).click();
    await openMarks(page);
    await expect(page.getByRole("tabpanel")).toContainText("Practice stop");
    await expect(page.getByRole("tabpanel")).toContainText("Practice buy");
    await placeOrder(page, "Close position");
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");
    await expectCleanScreen(page);

    // The thread reads back from the ledger: one closed trade on one ET date, and the balance is the starting balance plus the ledger rows (nothing stored twice).
    const ledger = (await get(context, `/threads/${threadId}/ledger`)) as { total: number; entries: Array<{ pnlUsd: number; day: string }> };
    expect(ledger.total).toBe(1);
    expect(ledger.entries[0]!.day, "the trade is dated by the ET date of its exit").toBe(DAY);
    const read = await readThread(context, threadId);
    expect(read.thread.stats.balance).toBeCloseTo(50000 + ledger.entries[0]!.pnlUsd, 2);
    expect(read.daily.map((date) => [date.day, date.trades])).toEqual([[DAY, 1]]);
    const balance = formatBalance(read.thread.stats.balance);

    // The Summary agrees with the balance, with no day language anywhere.
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(balance);
    await expect(page.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${threadId}`);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // The landing's row shows the balance; a click on the row opens the thread page, and its journal opens from there.
    await openDesk(page, "/practice");
    const card = threadRow(page);
    await expect(card).toContainText(balance);
    await expect(card).toContainText(PRACTICE_COPY.threadSimulated);
    await openRow(page, card);
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);

    // The journal is read live and grouped by ET date: a curve, a bar per date, tiles, the date list in the left rail.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Freestyle");
    await expect(page.getByText(PRACTICE_COPY.balanceNow)).toBeVisible();
    await expect(page.getByText(balance).first()).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance after each ET date/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Result of each ET date/ })).toBeVisible();
    const tile = (label: string) => page.getByRole("listitem").filter({ hasText: new RegExp(`^${label}`) });
    await expect(tile("ET dates traded")).toContainText("1");
    await expect(tile("Wins")).toContainText(String(read.thread.stats.wins));
    await expect(tile("Losses")).toContainText(String(read.thread.stats.losses));
    // D-039: her threads and the ET dates sit in the left rail; D-043: the journal's own status line.
    const journalLeft = page.getByRole("complementary", { name: "Practice side panel" });
    await expect(journalLeft).toContainText(PRACTICE_COPY.threadSwitcher);
    await expect(journalLeft).toContainText(PRACTICE_COPY.journalDatesTitle);
    await expect(page.getByLabel("Status")).toContainText(PRACTICE_COPY.statusJournalLive);
    await expect(page.getByLabel("Status")).toContainText(practiceText("statusBalanceAsOf", { day: DAY }));
    await expect(page.getByLabel("Status")).not.toContainText("Quotes:");
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // Edit the plan on the journal, then close the thread; the closed thread keeps its journal.
    const plan = await railSection(page, "Thread details", PRACTICE_COPY.threadPlanTitle);
    await expect(plan).toContainText("$600");
    await expect(plan).toContainText(PRACTICE_COPY.threadShares); // D-042: the full plan, Shares included
    await expect(plan).toContainText(PRACTICE_COPY.threadSharesNotSet); // a thread that never set an entry size says so
    await expect(plan).toContainText(`${PRACTICE_COPY.threadPlanNote}: Trade only clean pullbacks.`);
    await plan.getByRole("button", { name: PRACTICE_COPY.threadEditPlan }).click();
    await plan.getByLabel(PRACTICE_COPY.threadMaxLoss).fill("400");
    await plan.getByLabel(PRACTICE_COPY.threadShares).fill("250");
    await plan.getByRole("button", { name: PRACTICE_COPY.threadSavePlan }).click();
    await expect(plan).toContainText("$400");
    await expect(plan).toContainText("250"); // D-042: the entry size she set reads as the Shares row
    await expect(plan).not.toContainText(PRACTICE_COPY.threadSharesNotSet);
    expect((await readThread(context, threadId)).thread.shares).toBe(250);
    await expect(plan.getByRole("button", { name: PRACTICE_COPY.threadSavePlan })).toHaveCount(0);
    // D-040: Close thread is its own section of the rail (a tab of its own at 1180).
    const closing = await railSection(page, "Thread details", PRACTICE_COPY.threadClose);
    await closing.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await closing.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(page.getByRole("status").filter({ hasText: "This thread is closed" })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance after each ET date/ })).toBeVisible();
    await expect((await readThread(context, threadId)).thread.status).toBe("closed");
    await expectCleanScreen(page);

    // Back on the landing: the closed thread keeps its row (marked Closed), and a new thread can start again.
    await openDesk(page, "/practice");
    const closedRow = threadRow(page);
    await expect(closedRow).toContainText(PRACTICE_COPY.threadClosedBadge);
    await expect(closedRow).toContainText(balance);
    await expect(closedRow.getByRole("link", { name: PRACTICE_COPY.landingJournal, exact: true })).toBeVisible(); // a closed thread's one action
    const again = await clickNewPlan(page);
    await expect(again.getByRole("radio", { name: /swing/i })).toHaveCount(0); // no Day/Swing choice (ADR-0025)
    await expectCleanScreen(page);
  });

  test("a new thread's journal says there are no trades yet, and a thread that does not exist says it could not load", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    await openDesk(page, "/practice");
    const card = threadRow(page);
    await expect(card).toContainText(PRACTICE_COPY.threadPositionsNone); // nothing held yet
    await openDesk(page, `/practice/thread?id=${id}`);
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
    await expect(page.getByText(PRACTICE_COPY.journalEmpty)).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance after each ET date/ })).toHaveCount(0);
    await expectCleanScreen(page);

    // The bare journal route is gone (a journal opens only inside a thread): it sends her to Practice, with no thread picker.
    await openDesk(page, "/practice/journal");
    await page.waitForURL(/\/practice$/);
    await expect(page.getByText(PRACTICE_COPY.threadPickTitle)).toHaveCount(0);

    await openDesk(page, "/practice/journal?thread=99999");
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load this thread" })).toBeVisible();
    await expectCleanScreen(page);
  });

  // D-009, D-016: the New thread modal checks the starting balance against the contract's bounds and keeps the typed value. The server allows several
  // active threads at once, and the modal has no Day/Swing choice (ADR-0025).
  test("the New thread modal bounds the starting balance, keeps a custom one, and offers no Day or Swing choice", async ({ page, context }) => {
    test.setTimeout(180_000);
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog, { balance: "500" });
    const bounds = dialog.getByRole("alert").filter({ hasText: "1,000" }); // read as she types (M-03): no click needed
    await expect(bounds).toContainText("10,000,000");
    await expect(dialog.getByRole("button", { name: START_BUTTON })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: START_BUTTON }).click({ force: true });
    await expect(dialog).toBeVisible(); // nothing was created
    await dialog.getByLabel("Starting balance").fill("25000"); // a typed value keeps its digits until she leaves the box
    await dialog.getByLabel("Starting balance").blur();
    await expect(dialog.getByLabel("Starting balance")).toHaveValue("25,000");
    await discardNewPlan(page);

    const threadId = await startThread(page, context, { balance: "25000", filter: "Any close" });
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText("Started with $25,000");
    const listed = (await get(context, "/threads")) as Array<{ thread: { startingBalance: number; stats: { balance: number } } }>;
    expect([listed[0]!.thread.startingBalance, listed[0]!.thread.stats.balance]).toEqual([25000, 25000]);
    expect(((await get(context, `/threads/${threadId}/clock`)) as { state: string }).state, "a new thread's clock waits at its start").toBe("paused");

    // The server allows several active threads, so the modal can start another thread.
    await openDesk(page, "/practice");
    const again = await clickNewPlan(page);
    await expect(again.getByRole("radio", { name: /swing|day trading/i })).toHaveCount(0);
    await expect(again).not.toContainText("is already active");
    await expect(again.getByRole("button", { name: START_BUTTON })).toBeVisible();
    await expectCleanScreen(page);
    await page.keyboard.press("Escape");
    await openRow(page, threadRow(page));
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
  });

  test("a thread that is not chosen and one that is not found say different things on the Screen (D-116, D-117)", async ({ page }) => {
    await openDesk(page, "/practice/screen");
    await expect(page.getByText(PRACTICE_COPY.threadPickTitle)).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.screenPickHint)).toBeVisible();
    for (const bad of ["abc", "999999"]) {
      await openDesk(page, `/practice/screen?thread=${bad}`);
      await expect(page.getByText(PRACTICE_COPY.threadPageNotFound), bad).toBeVisible();
      await expect(page.getByText(PRACTICE_COPY.threadPickTitle), bad).toHaveCount(0);
      await expect(page.getByRole("link", { name: PRACTICE_COPY.openPractice })).toBeVisible();
    }
  });

  test("clicking a candidate row opens its lane, from the mouse and from the keyboard", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openScreenPage(page, context);
    const row = page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ });
    await row.getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();
    // The same from the keyboard: focus the row on the Screen, then Enter. The lane is resumed, not opened twice.
    await backToScreen(page);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  });

  test("the Portfolio reflects a new held position on the Portfolio tab only, never in the chart view or on the Screen", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await openScreenPage(page, context);
    const screenUrl = page.url();
    const portfolioRegion = page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle, exact: true });
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await stepBar(page);
    // Owner, 2026-11-01: the chart view shows no portfolio, before or after a trade, in the left rail or in a 1180 drawer.
    await placeOrder(page, "Buy");
    await expect(page.getByRole("tab", { name: "Marks" })).toBeVisible();
    await expect(portfolioRegion).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Practice side panel" })).not.toContainText(PRACTICE_COPY.portfolioTitle);
    await expect(page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
    // Back to the Screen: it shows the list of names and the lane she opened, no portfolio section and no Portfolio tab in the right rail.
    await backToScreen(page);
    await page.waitForURL(screenUrl);
    await expect(portfolioRegion).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Screen context" }).getByRole("tab", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
    await expect(page.getByTestId("screen-lanes").locator('[data-symbol="TSLA"]')).toContainText(/Long \d+/);
    // The Portfolio tab holds the row, priced at the thread's time, and an open P/L total.
    await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: "Portfolio", exact: true }).click();
    await page.waitForURL(/\/practice\/thread\?id=\d+&tab=portfolio/);
    await expect(portfolioRegion.getByTestId("portfolio-count")).toHaveText("1 open position");
    const cells = async () => {
      const heads = await portfolioRegion.getByRole("columnheader").allTextContents();
      const values = await portfolioRegion.getByRole("row", { name: /\bTSLA\b/ }).getByRole("cell").allTextContents();
      return Object.fromEntries(heads.map((head, index) => [head.trim(), (values[index] ?? "").trim()]));
    };
    await expect.poll(async () => (await cells())["Shares"] ?? "", { message: "TSLA is a long: unsigned shares" }).toMatch(/^\d[\d,]*$/);
    expect((await cells())["Avg cost"], "and the cost it was built at").toMatch(/^[\d,]+\.\d{2}$/);
    expect((await cells())["Price at thread time"], "and the price at the thread's time").toMatch(/^[\d,]+\.\d{2}$/);
    await expect(portfolioRegion.getByTestId("portfolio-total")).toContainText(PRACTICE_COPY.portfolioTotal);
    // The thread list counts it too.
    await openDesk(page, "/practice");
    await expect(threadRow(page).getByTestId("thread-positions")).toHaveText(PRACTICE_COPY.threadPositionsOne);
    expect(((await get(context, `/threads/${threadId}/portfolio`)) as { positions: unknown[] }).positions).toHaveLength(1);
  });

  test("the Screen names no cap anywhere: Open, Peek and Star on every row, and no count of names", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openScreenPage(page, context);
    const row = page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ });
    await expect(row.getByRole("button", { name: "Star TSLA" })).toBeVisible();
    await expect(page.getByTestId("names-today")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/Starred \d+ of|names practiced today|names a day|limits a day/i);
    await row.getByRole("button", { name: "Star TSLA" }).click();
    await expect(page.getByTestId("your-names")).toContainText("TSLA");
  });

  test("the Open action of a listed name is visible without a hover and sits inside the scroller's visible width (D-090)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openScreenPage(page, context);
    const button = page.getByRole("table", { name: "Candidates" }).getByRole("button", { name: "Open TSLA" });
    await expect(button).toBeVisible();
    await expect(button, "no hover needed").toHaveCSS("opacity", "1");
    // The table is wider than its scroller: the action is pinned to the right edge instead of sitting off-screen in the last column.
    const fits = await button.evaluate((node) => {
      const wrap = node.closest("table")!.parentElement!;
      const [b, w] = [node.getBoundingClientRect(), wrap.getBoundingClientRect()];
      return { overflow: wrap.scrollWidth > wrap.clientWidth, inside: b.left >= w.left - 1 && b.right <= w.right + 1 };
    });
    expect(fits.inside, "the Open action is inside the visible part of the table").toBe(true);
    const peek = await page.getByRole("table", { name: "Candidates" }).getByRole("button", { name: "Peek at TSLA" }).boundingBox();
    expect(Math.abs(peek!.y - (await button.boundingBox())!.y), "Open and Peek share one line in the pinned cell").toBeLessThan(2);
    await button.click();
    await page.waitForURL(REPLAY_URL);
  });

  test("the Screen's prices follow the thread clock: the table is read at the clock with no name opened, and the moving columns say \"now\"", async ({ page, context }) => {
    test.setTimeout(180_000);
    const api = watchApi(page);
    // D-159: every distinct column set the Candidates table shows, in order, from the first paint.
    await page.addInitScript(() => {
      const sets: string[] = [];
      (window as unknown as { screenSets: string[] }).screenSets = sets;
      const watch = () => {
        const head = document.querySelector('table[aria-label="Candidates"] thead');
        const headers = head ? [...head.querySelectorAll("th")].map((th) => th.textContent?.trim()).join("|") : "";
        if (headers && sets.at(-1) !== headers) sets.push(headers);
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    await openScreenPage(page, context);
    const table = page.getByRole("table", { name: "Candidates" });
    // The clock exists from the thread's start: the table is read at it before any name is opened.
    await expect(page.getByTestId("live-note")).toContainText(/follows? the thread clock/);
    await expect(table.getByRole("columnheader", { name: "Price now" })).toBeVisible();
    expect(api.paths().filter((path) => /threads\/\d+\/screen\?.*live=true/.test(path)).length, "the table asks for the clock's prices").toBeGreaterThan(0);
    // D-159: the read has landed (a price, not a placeholder or a dash) and the table never added, dropped or relabelled a column on the way.
    const firstNow = await table.getByRole("columnheader").evaluateAll((headers) => headers.findIndex((header) => header.textContent?.trim() === "Price now"));
    await expect(table.getByRole("row", { name: /TSLA/ }).getByRole("cell").nth(firstNow)).toHaveText(/^\d[\d,]*\.\d{2}$/);
    expect(await page.evaluate(() => (window as unknown as { screenSets: string[] }).screenSets), "one column set from the first paint").toHaveLength(1);

    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(REPLAY_URL);
    await stepBar(page, 2);
    await backToScreen(page);
    await expect(page.getByTestId("live-note")).toContainText("follow the thread clock");
    await expect(page.getByTestId("live-note")).toContainText("fixed at the");
    await expect(table.getByRole("columnheader", { name: PRACTICE_COPY.screenPriceAtScan })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Price now" })).toBeVisible();
    const now = table.getByRole("columnheader").evaluateAll((headers) => headers.findIndex((header) => header.textContent?.trim() === "Price now"));
    const cell = table.getByRole("row", { name: /TSLA/ }).getByRole("cell").nth(await now);
    await expect(cell, "the price at the clock is a number, never a dash for a name with bars").toHaveText(/^\d[\d,]*\.\d{2}$/);
    await expectCleanScreen(page);
  });

  test("the Screen has no left rail and no portfolio: only the thread plan sits in the right rail, at 1440 and at 1180", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openScreenPage(page, context);
    await expect(page.locator('aside[aria-label="Practice side panel"]'), "nothing is stacked on the left of the Screen").toBeEmpty();
    const narrow = test.info().project.name === "desktop-1180";
    if (narrow) await expect(page.getByRole("tablist", { name: "Screen context" }).getByRole("tab")).toHaveText([PRACTICE_COPY.threadPlanTitle]);
    else await expect(page.getByRole("complementary", { name: "Screen context" }).locator(":scope > section")).toHaveCount(1);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle }), "the portfolio is the Portfolio tab's").toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Screen context" }).getByRole("tab", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
  });

  test("while the Screen loads the page shows its own shape and says it is busy (D-116)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openScreenPage(page, context);
    const url = page.url();
    await page.route(/\/api\/desk\/replay\/threads\/\d+\/screen/, async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.goto(url);
    await expect(page.locator('[role="status"][aria-busy="true"]')).toBeVisible();
    await expect(page.getByRole("table", { name: "Candidates" })).toBeVisible();
  });

  test("the Screen's title is the ET date and weekday of the thread's time, with the page kind as a chip (D-139)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openScreenPage(page, context);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Screen · Fri 2026-09-25");
    await expect(page.getByText(PRACTICE_COPY.screenBadge, { exact: true })).toBeVisible();
    await expectNoDayLanguage(page);
  });
});
