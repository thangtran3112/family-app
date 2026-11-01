import type { BrowserContext, Page } from "@playwright/test";
import { formatEtDay } from "../../lib/desk/format.ts";
import { formatBalance, formatDayResult } from "../../lib/replay/threadView.ts";
import { PRACTICE_COPY, practiceBandText, practiceText } from "../../lib/desk/freshness.ts";
import { defaultDraft, draftToSpec, type SetupDraft } from "../../lib/replay/setup.ts";
import { origin } from "../helpers";
import { brokenTileValues, expect, expectBacktestChrome, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";
import { DAY, START_BUTTON, THREAD_URL, clickNewPlan, createStubSession, createThreadByApi, discardNewPlan, fillNewPlan, openFirstDay, openNewPlan, openRow, saveFilter, setRiskPlan, startThread } from "./hub-helpers";
import { openNextDay, replayRail, send } from "./swing-helpers";

// The Practice lane (02o §i, step 5): the landing and its New plan modal (02r2) start a thread; play, step, B, T, S/X, end, the
// journal, and a reloaded session follow. The landing no longer starts a single session, so those specs make one through the API.
// The backend runs with `DESK_REPLAY_STUB=1` (`replay/fixture.py`): the one replayable day is TSLA on Fri 2026-09-25
// and the tape holds its first ten minutes after the open, so every session here replays 09:30 to 09:40 ET.

const SESSION_URL = /\/practice\/replay\?id=\d+/;
const JOURNAL_URL = /\/practice\/journal\?id=\d+/;
const LIVE_DATA = /\/api\/desk\/(bars|technicals|quotes|charts)\b/;

/** Every `/api/desk/replay/...` answer, parsed, so a spec can check what the browser was ever told. */
function watchReplayAnswers(page: Page) {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/desk/replay/") || !response.ok()) return;
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object" && !Array.isArray(body)) bodies.push({ path: url.pathname, body: body as Record<string, unknown> });
  });
  return bodies;
}

const playhead = (page: Page) => page.getByTestId("thread-clock-time"); // the thread's one clock, in the bar above every name
const marksTab = (page: Page) => page.getByRole("tab", { name: "Marks" });
/** Opens the Marks tab and hands the keyboard back to the replay: a focused tab owns the arrow keys (ui/Tabs), and → steps the replay. */
const openMarks = async (page: Page) => {
  await marksTab(page).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
};

/** A right-rail section: stacked in the rail at 1440, a drawer behind the strip at 1180 (it opens here). */
async function railSection(page: Page, rail: string, section: string) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: rail });
  await page.getByRole("tablist", { name: rail }).getByRole("tab", { name: section }).click();
  const drawer = page.getByRole("dialog", { name: section });
  await expect(drawer).toBeVisible();
  return drawer;
}

/** A stub-day session made through the API (the landing no longer starts one), opened on its replay screen. `draft` fields (such as `armed`) are laid over the TSLA / 1m / 09:30 to 09:40 setup. */
async function startStubSession(page: Page, context: BrowserContext, draft: Partial<SetupDraft> = {}) {
  const id = await createStubSession(context, draft);
  await openDesk(page, `/practice/replay?id=${id}`);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
  return id;
}

/** The landing's row for the active day thread (the table of her threads, 02r2). */
const dayRow = (page: Page) => page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel }).getByRole("row", { name: /Day trading/ });

/** A thread answered by the API: the numbers the screens must agree with. */
async function readThread(context: BrowserContext, id: number) {
  const answer = await context.request.get(`${origin}/api/desk/replay/threads/${id}`);
  expect(answer.ok()).toBeTruthy();
  return (await answer.json()) as {
    thread: { id: number; startingBalance: number; status: string; stats: { balance: number; daysPracticed: number; daysSkipped: number; wins: number; losses: number } };
    daily: Array<{ n: number; kind: string; pnl_usd: number; balance: number }>;
    curve: Array<{ n: number; balance: number }>;
  };
}

test.describe("Practice", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the landing shows the Practice band, and a stub session opens on its replay screen without reading the live store", async ({ page, context }) => {
    const api = watchApi(page);
    await openDesk(page, "/practice");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(null));
    await expect(page.getByRole("heading", { name: "Practice", level: 1 })).toBeVisible();
    // ADR-0014: Practice is Backtest mode, with no live-market chrome.
    await expectBacktestChrome(page, "Practice");
    await expectCleanScreen(page);

    expect((await page.request.get(`${origin}/favicon.ico`)).ok(), "D-010: the export ships a favicon").toBeTruthy();

    await startStubSession(page, context);
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expectBacktestChrome(page, "Practice");
    await expectCleanScreen(page);
    expect(api.paths().filter((path) => LIVE_DATA.test(path)), "a replay screen never reads the live store").toEqual([]);
  });

  test("arming a saved alert strategy starts a session that lists it", async ({ page, context }) => {
    const strategies = (await (await context.request.get(`${origin}/api/desk/alert-strategies`)).json()) as Array<{ id: number; name: string }>;
    const orb = strategies.find((row) => row.name === "ORB 15m");
    expect(orb, "the seed ships ORB 15m").toBeDefined();
    const id = await startStubSession(page, context, { armed: [{ source: "alert_strategy", id: orb!.id }] });
    // The armed list lives in the left rail (1440) or its collapsed strip (1180); the session itself says what it armed.
    const answer = await context.request.get(`${origin}/api/desk/replay/sessions/${id}`);
    const body = (await answer.json()) as { armed: Array<{ name: string; fires_so_far: number }> };
    expect(body.armed.map((item) => item.name)).toEqual(["ORB 15m"]);
    await expectCleanScreen(page);
  });

  test("a session with a hidden day keeps its date off the screen", async ({ page, context }) => {
    await startStubSession(page, context, { dayHidden: true });
    // D-023: a hidden day says why it is hidden and offers "Show date"; the date stays off the screen until she asks.
    await expect(page.getByText(PRACTICE_COPY.bandHiddenWhy)).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.showDate })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(DAY);
    await expectCleanScreen(page);
  });

  test("a day with no stored trades is refused in plain words instead of opening a session", async ({ context }) => {
    const spec = draftToSpec({ ...defaultDraft(), symbol: "NVDA", day: "2026-09-24" });
    const refused = await context.request.post(`${origin}/api/desk/replay/sessions`, { data: spec });
    expect(refused.ok()).toBeFalsy();
    expect(refused.status()).toBeLessThan(500);
    expect(JSON.stringify(await refused.json())).not.toContain("Traceback");
    expect(((await (await context.request.get(`${origin}/api/desk/replay/sessions`)).json()) as unknown[]).length, "nothing was opened").toBe(0);
  });

  test("play moves the playhead, step moves it one bar, and the shortcuts overlay opens on ?", async ({ page, context }) => {
    const answers = watchReplayAnswers(page);
    await startStubSession(page, context);
    const clock = playhead(page);
    await expect(clock).toContainText("9:30");

    // Space plays; key 4 picks 10x. The clock only ever moves forward.
    await page.keyboard.press("4");
    await page.keyboard.press("Space");
    await expect(page.getByText(practiceText("playing", { speed: 10 }))).toBeVisible();
    await expect(page.getByText("Playing · 10x")).toBeVisible(); // D-025: the player's state as a pill beside the thread's clock
    // D-024: the tape has its BIG column and names the pace window.
    await expect(page.getByRole("columnheader", { name: "Big" })).toBeVisible();
    await expect(page.getByText("Pace · 10 seconds")).toBeVisible();
    await expect(clock).not.toContainText("9:30:00", { timeout: 10_000 });
    await page.keyboard.press("Space");
    await expect(page.getByText(/^Paused at /)).toBeVisible();

    const before = await clock.innerText();
    await page.keyboard.press("ArrowRight");
    await expect(clock).not.toHaveText(before);

    // D-036, D-025: the header's Practice P/L reads with its SIMULATED unit, beside VWAP and the prior close.
    await expect(page.getByTitle("Closed practice trades plus the open trade at the last price")).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(page.locator("dt", { hasText: "VWAP" })).toBeVisible();
    await expect(page.locator("dt", { hasText: "Prior close" })).toBeVisible();
    // D-023: this session shows its date, so the band has nothing to hide and no "Show date" (the hidden-day case is below).
    await expect(page.getByRole("button", { name: PRACTICE_COPY.showDate })).toHaveCount(0);
    // D-043: the replay has its own status line, not the live-quotes one.
    await expect(page.getByLabel("Status")).toContainText("Prices: Alpaca SIP · replay");
    await expect(page.getByLabel("Status")).not.toContainText("Alerts start when live quotes are connected");
    // D-020: at the 1180 band each tab opens its own drawer; one never closes another.
    if (test.info().project.name === "desktop-1180") {
      const tabs = page.getByRole("tablist", { name: "Replay context" });
      await expect(tabs.getByRole("tab", { name: "Tape" })).toHaveAttribute("aria-selected", "true"); // opened by play
      await tabs.getByRole("tab", { name: "Practice" }).click();
      await expect(tabs.getByRole("tab", { name: "Tape" })).toHaveAttribute("aria-selected", "true");
      await expect(tabs.getByRole("tab", { name: "Practice" })).toHaveAttribute("aria-selected", "true");
    }

    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
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

  test("B, T and X place practice marks; undo removes the last one; End and score opens the journal with the trade", async ({ page, context }) => {
    await startStubSession(page, context);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).not.toContainText("9:30:00");

    // A practice long, priced at the replayed last price.
    await page.keyboard.press("b");
    await openMarks(page);
    const marks = page.getByRole("tabpanel");
    await expect(marks).toContainText("Practice buy");

    // T opens the stop note; Enter saves it.
    await page.keyboard.press("t");
    const stop = page.getByRole("form", { name: "Stop" });
    await expect(stop).toBeVisible();
    await stop.getByRole("textbox").fill("180");
    await stop.getByRole("button", { name: "Save" }).click();
    await expect(marks).toContainText("Practice stop");

    // Exit with X, take it back with undo, exit again.
    await page.keyboard.press("x");
    await expect(marks).toContainText("Practice exit");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByText(PRACTICE_COPY.undone)).toBeVisible();
    await expect(marks).not.toContainText("Practice exit");
    await page.keyboard.press("s"); // Sell with the ticket's quantity: every share of the long, so it closes
    await expect(marks).toContainText("Practice sell");
    await expectCleanScreen(page);

    // Ending early asks first, then scores and opens the journal.
    await page.getByRole("button", { name: "End session…" }).click();
    await expect(page.getByText(PRACTICE_COPY.endEarlyWarning)).toBeVisible();
    await page.getByRole("button", { name: PRACTICE_COPY.endAndScore }).click();
    await page.waitForURL(JOURNAL_URL);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Practice journal");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA");
    await expect(page.getByRole("listitem").filter({ hasText: /^Trades/ })).toContainText("1");
    expect(await brokenTileValues(page), "a journal tile value wraps or spills (D-086)").toEqual([]);
    await expect(page.getByRole("table", { name: "Practice trades" }).getByRole("row")).toHaveCount(2); // header + the trade
    await expectCleanScreen(page);

    // Notes and the self-rating save through the one PATCH route.
    const details = await railSection(page, "Journal details", "Adherence");
    await details.getByLabel("Session notes").fill("Waited for the first pullback.");
    await details.getByRole("button", { name: "Save notes" }).click();
    await expect(details.getByText(PRACTICE_COPY.notesSaved)).toBeVisible();
    await details.getByRole("radio", { name: "4" }).click();
    await expect(details.getByRole("radio", { name: "4" })).toBeChecked();
  });

  test("a reloaded session restores the playhead", async ({ page, context }) => {
    await startStubSession(page, context);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const clock = playhead(page);
    await expect(clock).not.toContainText("9:30:00");
    const placed = await clock.innerText();

    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(placed);
    await expectCleanScreen(page);
  });

  test("jump to the window end shows the end prompt, and the journal of an unfinished session stays open", async ({ page, context }) => {
    await startStubSession(page, context);
    await page.getByRole("button", { name: /^Jump/ }).click();
    await page.getByRole("dialog", { name: "Jump forward" }).getByRole("button", { name: /^To the window end/ }).click();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.endAndScore })).toBeVisible();
    await expect(page.getByText(/^Session over/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
    await expectCleanScreen(page);

    await page.getByRole("button", { name: PRACTICE_COPY.endAndScore }).click();
    await page.waitForURL(JOURNAL_URL);
    await expect(page.getByText(PRACTICE_COPY.noTradesJournal).first()).toBeVisible();
    await expectCleanScreen(page);
  });

  // Daily-list practice (02o-b v1): the plan, the day list before the open, Peek, a row click that opens a practice session, the end of
  // the day and its review, then the next day. The stub holds TSLA on Fri 2026-09-25 only, so Day 1 lists TSLA through her
  // own always-matching daily filter and Day 2 lists nothing; the plan's data is fetched in the background first.
  test("a daily plan opens a hidden-date day list with Peek, opens a name from a row click, ends into the review, and Continue opens Day 2", async ({ page, context }) => {
    test.setTimeout(180_000);
    const answers = watchReplayAnswers(page);
    const api = watchApi(page);
    await saveFilter(context); // her own always-matching daily filter; TSLA only: the fixture's stand-in names trade below $200

    // The landing's New plan modal starts the thread and its plan in one go; its risk plan (a $600 daily loss, at most 3 trades) is set on the thread (D-076).
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog);
    await expectCleanScreen(page);
    await expect(dialog.getByRole("button", { name: "Save plan" })).toHaveCount(0); // D-003: the button says what it does
    await dialog.getByRole("button", { name: START_BUTTON }).click();

    // The thread page: prep runs once in the background; Day 1 opens when the data is ready.
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    const threadId = Number(new URL(page.url()).searchParams.get("id"));
    await setRiskPlan(context, threadId, { maxLoss: "600", maxTrades: "3", note: "Trade only clean pullbacks.", stop: true });
    await openDesk(page, `/practice/thread?id=${threadId}`);
    const planCard = page.getByRole("region", { name: "Daily list plan" });
    await expect(planCard).toContainText("Day 1 of 5 · next: Fri", { timeout: 60_000 });
    await expect(planCard).toContainText("Any close"); // the card names the filter once (D-118: the armed line is gone with the arming)
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(formatBalance(50_000));
    await expect(page.locator("body")).not.toContainText(DAY);
    await expectCleanScreen(page);
    await openFirstDay(page);
    const dayUrl = page.url();

    // D-004: the bare route finds the day she has open.
    await openDesk(page, "/practice/day");
    await page.waitForURL(dayUrl);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5 · Fri");

    // The day list: dates hidden, the candidate, the universe line, and the footnote.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5 · Fri");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY, true, true));
    await expect(page.getByText(/^List built at 8:30 AM ET from data through 8:15 AM/)).toBeVisible();
    await expect(page.getByText(/Universe: today's Desk set, up to 250 names by today's dollar volume \(\d+ names here\)/).first()).toBeVisible();
    const table = page.getByRole("table", { name: "Candidates" });
    await expect(table.getByRole("row", { name: /TSLA/ })).toBeVisible();
    // D-013, D-014, D-018: the P7 layout (the portfolio, the thread and the block on the left), the chips read as on, the P7 columns.
    const left = page.getByRole("complementary", { name: "Practice side panel" });
    await expect(left).toContainText("This block · 5 days");
    await expect(left).toContainText("Risk plan comes from the thread: ");
    await expect(page.getByRole("list", { name: "Filters" }).getByRole("listitem").first()).toHaveAttribute("data-active", "true");
    await expect(page.getByText("Chosen at setup")).toBeVisible();
    for (const label of ["Prev close", "Prev RVOL", "Prev change %"]) await expect(table.getByRole("columnheader", { name: label })).toBeVisible();
    // D-136: no name reports before the open, so there is no Earnings column of dashes to scroll past.
    await expect(table.getByRole("columnheader", { name: "Earnings" })).toHaveCount(0);
    // D-043: the day list's own status line.
    await expect(page.getByLabel("Status")).toContainText("Day lists built before the open");
    await expect(page.getByLabel("Status")).toContainText("List built 8:30 AM ET");
    await expect(page.locator("body")).not.toContainText(DAY);
    await expectCleanScreen(page);

    // Peek: the chart before the open, from the row's own button, in a wide drawer. It adds nothing to the portfolio and starts no clock.
    const peekButton = table.getByRole("row", { name: /TSLA/ }).getByRole("button", { name: "Peek at TSLA" });
    await peekButton.click();
    const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.dayPeek });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "TSLA", level: 3 })).toBeVisible();
    await expect(drawer.getByRole("tab", { name: PRACTICE_COPY.dayPeekToday })).toBeVisible(); // D-019: no "Today so far" on a replay day
    await expect(page.getByText("Today so far")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /star/i })).toHaveCount(0); // practice = portfolio: no star
    await expectCleanScreen(page);
    // The drawer is wider than the 320 px rail it replaced, so the chart is readable; its levels are named in a legend in normal
    // flow above the plot (never printed over the candles), and no two entries touch.
    const chartBox = (await drawer.getByRole("region", { name: "TSLA 1m market chart" }).boundingBox())!;
    expect(chartBox.width, "the Peek chart is wider than the old 320 px rail").toBeGreaterThan(500);
    expect(chartBox.height, "the Peek chart is taller than the old 260 px").toBeGreaterThanOrEqual(380);
    const legend = drawer.getByTestId("peek-levels");
    await expect(legend).toContainText(PRACTICE_COPY.dayPeekLevels);
    await expect(legend).toContainText("List price");
    const entries = await legend.locator(":scope > div > span").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }));
    expect(entries.length, "List price and at least one more level").toBeGreaterThanOrEqual(2);
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
    await drawer.getByRole("button", { name: PRACTICE_COPY.dayPeekClose }).click();
    await expect(drawer).toHaveCount(0);
    await expect(peekButton).toBeFocused();

    // Click the row: the practice chart opens at the window start, with a way back to the list.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToList })).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToPractice }), "one back link on the workspace, the one at the foot (D-146)").toHaveCount(0);
    await expect(page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: PRACTICE_COPY.tabTrade })).toHaveAttribute("aria-selected", "true");
    // D-023: a hidden day says why it is hidden and offers "Show date"; the date stays off the screen until she asks.
    await expect(page.getByText(PRACTICE_COPY.bandHiddenWhy)).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.showDate })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(DAY);
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).not.toContainText("9:30:00");
    await expectCleanScreen(page);

    // The workspace carries the thread: its balance and today's result (SIMULATED), and the thread plan in the rail.
    const strip = page.getByRole("group", { name: "Practice thread" });
    await expect(strip).toContainText("Thread balance $50,000");
    await expect(strip).toContainText(PRACTICE_COPY.threadSimulated);
    // D-021: the THREAD PLAN rail lists every rule, the plan note and the SIMULATED pill.
    const side = page.getByRole("complementary", { name: "Practice side panel" });
    for (const label of ["Shares per trade", "Stop note on every entry", "Trade only on a signal", "Max loss $600.00", "Max trades 3"]) await expect(side).toContainText(label);
    await expect(side).toContainText("Plan note: Trade only clean pullbacks.");
    await expect(side.getByText(PRACTICE_COPY.threadSimulated).first()).toBeVisible();
    // A practice trade: the exit mark books one ledger row, so the thread balance moves with it.
    // The one size rule is the account's cash: a quantity the balance cannot cover (here far past 10,000 shares) is refused with the free cash, and nothing else limits a size.
    const practice = await replayRail(page, "Practice");
    await practice.getByRole("textbox", { name: "Quantity" }).fill("100000");
    await practice.getByRole("button", { name: "Buy" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Not enough practice cash · $50,000 free" })).toBeVisible();
    await expect(practice.getByRole("textbox", { name: "Quantity" }), "the refusal names shares, so Quantity is the invalid field").toHaveAttribute("aria-invalid", "true");
    await practice.getByRole("textbox", { name: "Quantity" }).fill("100");
    // A stop is optional even when the thread plan asks for one: Buy places the entry, with no refusal and no warning.
    await practice.getByRole("button", { name: "Buy" }).click();
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Dismiss message" }) })).toHaveCount(0);
    await expect(practice.getByRole("button", { name: "Buy" })).toBeEnabled();
    await expect(practice.getByRole("button", { name: "Buy" }), "no hint ties the buttons to a stop").not.toHaveAccessibleDescription(/stop/i);
    // Set stop (T) on the open position afterwards; it is the same optional stop, typed in the stop form.
    await practice.getByRole("button", { name: "Set stop" }).click();
    const stopForm = practice.getByRole("form", { name: "Stop" });
    await stopForm.getByRole("textbox").fill("150");
    await stopForm.getByRole("button", { name: "Save" }).click();
    await openMarks(page);
    await expect(page.getByRole("tabpanel")).toContainText("Practice stop");
    await expect(page.getByRole("tabpanel")).toContainText("Practice buy");
    await page.keyboard.press("x");
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");
    await expect(strip).toContainText("today");
    await expectCleanScreen(page);

    // End the day from the workspace: it asks first, then opens the list with its review.
    await page.getByRole("button", { name: "End day…" }).click();
    await expect(page.getByText(PRACTICE_COPY.dayEndWarning)).toBeVisible();
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.waitForURL(dayUrl);
    const review = page.getByRole("region", { name: PRACTICE_COPY.reviewTitle });
    await expect(review).toBeVisible();
    await expect(review).toContainText("Your names moved");
    await expect(review).toContainText(PRACTICE_COPY.reviewDayFinished); // D-029: the finished day shows its date, and says so
    await expect(review).toContainText(PRACTICE_COPY.reviewRankNote); // D-031: signed, biggest gain first
    const trades = review.getByRole("table", { name: "Your practice trades" });
    await expect(trades).toBeVisible(); // D-032: a line per trade
    for (const label of ["In at", "Out at", "Held", "P/L", "Return"]) await expect(trades.getByRole("columnheader", { name: label })).toBeVisible(); // D-142: time, hold time and return each get a column
    await expect(review).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(review.getByRole("table", { name: PRACTICE_COPY.reviewTitle }).getByRole("row")).toHaveCount(2); // header + TSLA
    await expect(review).toContainText("Practice universe");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`Day 1 of 5 · ${formatEtDay(DAY)}`); // nothing left to spoil
    await expectCleanScreen(page);

    // Before it ended, the list carried nothing later than its data time, and no review.
    const lists = answers.filter(({ path }) => /\/day-lists\/\d+$/.test(path));
    expect(lists.length).toBeGreaterThan(0);
    for (const { body } of lists) {
      if (body.status === "ended") continue;
      const through = Date.parse(body.data_through as string);
      expect(body.review ?? null).toBeNull();
      for (const candidate of (body.candidates as Array<{ price_at: string; matched_since: string }>) ?? []) {
        expect(Date.parse(candidate.price_at)).toBeLessThanOrEqual(through);
        expect(Date.parse(candidate.matched_since)).toBeLessThanOrEqual(Date.parse(body.list_at as string));
      }
      const peek = body.peek as { minutes: Array<{ t: string }>; daily: Array<{ t: string }> } | null;
      for (const bar of peek?.minutes ?? []) expect(Date.parse(bar.t) + 60_000).toBeLessThanOrEqual(through);
      for (const bar of peek?.daily ?? []) expect(bar.t < DAY, "a daily bar of the day itself").toBe(true);
    }
    expect(api.paths().filter((path) => LIVE_DATA.test(path)), "the day screens never read the live store").toEqual([]);

    // The thread page: the plan card moves to Day 2, and the day that ended reads done, never "in progress".
    await openDesk(page, `/practice/thread?id=${threadId}`);
    const planNow = page.getByRole("region", { name: "Daily list plan" });
    await expect(planNow).toContainText("Day 2 of 5 · next: Mon");
    await expect(planNow).toContainText("Day 1 done"); // D-035
    await expect(planNow).not.toContainText("in progress");
    // D-030: with no day open the thread's day row is the last ended day, the same ledger figure as the balance.
    const afterDayOne = await readThread(context, threadId);
    const lastDay = page.getByRole("region", { name: "Practice day" });
    await expect(lastDay).toContainText("Last day");
    await expect(lastDay).toContainText(`${formatDayResult(afterDayOne.daily[0]!.pnl_usd)} realized · 1 practice trade`);
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(formatBalance(afterDayOne.thread.stats.balance));
    // The thread page charts the win/loss of her days, and the journal is a link of its own.
    await expect(page.getByRole("region", { name: PRACTICE_COPY.overviewCurveTitle }).getByRole("img", { name: /^Balance at the end of each day/ })).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${threadId}`);
    // Resume: the landing's row opens Day 2, which has no stored TSLA bars, so its list is empty and says so.
    await openDesk(page, "/practice");
    await dayRow(page).getByRole("button", { name: /^Start Day 2$/ }).click(); // D-078: after an ended day the action starts the next one
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 5 · Mon");
    await expect(page.getByText(PRACTICE_COPY.dayNoMatchTitle)).toBeVisible();
    // D-005: the banner names the cause (the stub holds no bars for this day), not "Only 0 names matched".
    await expect(page.getByRole("status").filter({ hasText: "No symbol could be scanned" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Only 0");
    await expectCleanScreen(page);

    // End day 2 with no practice: a skipped day. The balance simply carries.
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayAfter })).toBeVisible();

    // The thread reads back from the ledger: one practiced day, one skipped day, and the balance is the starting
    // balance plus the ledger rows (nothing stored twice).
    const listed = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { id: number } }>;
    expect(listed.map((row) => row.thread.id)).toEqual([threadId]);
    const ledger = (await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/ledger`)).json()) as { total: number; entries: Array<{ pnlUsd: number }> };
    expect(ledger.total).toBe(1);
    const read = await readThread(context, threadId);
    expect(read.thread.stats.balance).toBeCloseTo(50000 + ledger.entries[0]!.pnlUsd, 2);
    expect([read.thread.stats.daysPracticed, read.thread.stats.daysSkipped]).toEqual([1, 1]);
    expect(read.daily.map((day) => day.kind)).toEqual(["practiced", "skipped"]);
    expect(read.daily[1]!.balance, "a skipped day carries the balance").toBe(read.daily[0]!.balance);
    const balance = formatBalance(read.thread.stats.balance);

    // The landing's row shows the balance; a click on the row opens the thread page, and its journal opens from there.
    await openDesk(page, "/practice");
    const card = dayRow(page);
    await expect(card).toContainText(balance);
    await expect(card).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(card.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveCount(0); // the journal is a link of the thread page, not of the row
    await openRow(page, card);
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Thread ·");
    await expect(page.getByText(PRACTICE_COPY.balanceNow)).toBeVisible();
    await expect(page.getByText(balance).first()).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance at the end of each day/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Result of each day.*1 passed\.$/ })).toBeVisible();
    const tile = (label: string) => page.getByRole("listitem").filter({ hasText: new RegExp(`^${label}`) });
    await expect(tile("Days practiced")).toContainText("of 2 days opened");
    await expect(tile(PRACTICE_COPY.threadSkipped)).toContainText(PRACTICE_COPY.threadTileCarried);
    await expect(tile("Wins")).toContainText(String(read.thread.stats.wins));
    await expect(tile("Losses")).toContainText(String(read.thread.stats.losses));
    await expect(page.locator("body")).not.toContainText(/20\d\d-\d\d-\d\d/); // dates stay hidden on the journal
    // D-039: her threads and the weeks sit in the left rail; D-043: the journal's own status line.
    const journalLeft = page.getByRole("complementary", { name: "Practice side panel" });
    await expect(journalLeft).toContainText(PRACTICE_COPY.threadSwitcher);
    await expect(journalLeft).toContainText(PRACTICE_COPY.weeksTitle);
    await expect(page.getByLabel("Status")).toContainText("Journal updates when a day ends");
    await expect(page.getByLabel("Status")).toContainText("Balance as of day 2");
    await expect(page.getByLabel("Status")).not.toContainText("Quotes:");
    await expectCleanScreen(page);

    // One practiced day is too few for a trend, and the journal says so instead of guessing.
    const improvement = await railSection(page, "Thread details", PRACTICE_COPY.improvementTitle);
    await expect(improvement.getByText(PRACTICE_COPY.improvementTooFew)).toBeVisible();
    await expect(improvement.getByText(/^Reason: week 2 has no practice days so far/)).toBeVisible();
    await expect(improvement.getByText(PRACTICE_COPY.threadSimulated).first()).toBeVisible(); // D-041

    // Edit the plan on the journal, then close the thread; the closed thread keeps its journal.
    const plan = await railSection(page, "Thread details", PRACTICE_COPY.threadPlanTitle);
    await expect(plan).toContainText("$600");
    await expect(plan).toContainText(PRACTICE_COPY.threadShares); // D-042: the full plan, Shares included
    await expect(plan).toContainText(`${PRACTICE_COPY.threadPlanNote}: Trade only clean pullbacks.`);
    await plan.getByRole("button", { name: PRACTICE_COPY.threadEditPlan }).click();
    await plan.getByLabel("Max loss ($)").fill("400");
    await plan.getByRole("button", { name: PRACTICE_COPY.threadSavePlan }).click();
    await expect(plan).toContainText("$400");
    await expect(plan.getByRole("button", { name: PRACTICE_COPY.threadSavePlan })).toHaveCount(0);
    // D-040: Close thread is its own section of the rail (a tab of its own at 1180).
    const closing = await railSection(page, "Thread details", PRACTICE_COPY.threadClose);
    await closing.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await closing.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(page.getByRole("status").filter({ hasText: "This thread is closed" })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance at the end of each day/ })).toBeVisible();
    await expect((await readThread(context, threadId)).thread.status).toBe("closed");
    await expectCleanScreen(page);

    // Back on the landing: the closed thread keeps its row (marked Closed, no Resume), and a new plan can start a thread again.
    await openDesk(page, "/practice");
    const closedRow = dayRow(page);
    await expect(closedRow).toContainText(PRACTICE_COPY.threadClosedBadge);
    await expect(closedRow).toContainText(balance);
    await expect(closedRow.getByRole("button", { name: /Day \d+$/ })).toHaveCount(0);
    await expect(closedRow.getByRole("link", { name: PRACTICE_COPY.landingJournal, exact: true })).toBeVisible(); // a closed thread's one action
    const again = await clickNewPlan(page);
    await expect(again.getByRole("radio", { name: PRACTICE_COPY.threadModeDay })).toBeEnabled();
    await expect(again.getByRole("radio", { name: PRACTICE_COPY.threadModeDay })).toBeChecked();
    await expectCleanScreen(page);
  });

  test("a new thread's journal says there are no days yet, and a thread that does not exist says it could not load", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    await openDesk(page, "/practice");
    const card = dayRow(page);
    await expect(card).toContainText(PRACTICE_COPY.landingNeedsPlan); // no daily plan yet: nothing to resume
    await expect(card.getByRole("button", { name: /Day \d+$/ })).toHaveCount(0);
    await openDesk(page, `/practice/thread?id=${id}`);
    await expect(page.getByRole("region", { name: "Practice day" }).getByRole("button", { name: PRACTICE_COPY.landingNeedsPlan })).toBeVisible();
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
    await expect(page.getByText("$50,000.00 · 0 days practiced")).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.journalThreadEmpty)).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance at the end of each day/ })).toHaveCount(0);
    await expectCleanScreen(page);

    // D-037: the bare journal route says no thread is picked and links to hers.
    await openDesk(page, "/practice/journal");
    await expect(page.getByText(PRACTICE_COPY.threadPickTitle)).toBeVisible();
    await page.getByRole("link", { name: /thread/i }).first().click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);

    await openDesk(page, "/practice/journal?thread=99999");
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load this thread" })).toBeVisible();
    await expectCleanScreen(page);
  });

  // D-009, D-016: the New plan modal checks the starting balance against the contract's bounds and keeps the typed value. With a day
  // thread active both segments stay on offer: several threads of a mode can run at once.
  test("the New plan modal bounds the starting balance, keeps a custom one, and still offers Day while a day thread is active", async ({ page, context }) => {
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

    await startThread(page, context, { balance: "25000", filter: "Any close" });
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText("Started with $25,000");
    const listed = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { startingBalance: number; stats: { balance: number } } }>;
    expect([listed[0]!.thread.startingBalance, listed[0]!.thread.stats.balance]).toEqual([25000, 25000]);

    // The server allows several active threads per mode, so the modal keeps both segments on and Day can start another thread.
    await openDesk(page, "/practice");
    const again = await clickNewPlan(page);
    await expect(again.getByRole("radio", { name: PRACTICE_COPY.threadModeDay })).toBeEnabled();
    await expect(again.getByRole("radio", { name: PRACTICE_COPY.threadModeDay })).toBeChecked();
    await expect(again.getByRole("radio", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toBeEnabled();
    await expect(again).not.toContainText("is already active");
    await expect(again.getByRole("button", { name: START_BUTTON })).toBeVisible();
    await expectCleanScreen(page);
    await page.keyboard.press("Escape");
    await openRow(page, dayRow(page));
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
  });

  // D-030, D-035: replacing the plan while a day is half practiced ends that day (its P/L stays in the ledger), so only the
  // new plan's Day 1 is open. The thread page must agree with the balance and the review: Day 1 reads "list ready" (not "in
  // progress"), the thread's day row is the day just ended (not a $0 for the unstarted one), and Continue and the review's
  // Next day meet.
  test("replacing the plan ends the half-practiced day; the thread page and its day row agree with the balance and the review", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    const practiced = page.url();

    // Practice the name and take a trade; the day stays open.
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).not.toContainText("9:30:00");
    await page.keyboard.press("b");
    await openMarks(page);
    await expect(page.getByRole("tabpanel")).toContainText("Practice buy");
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("x");
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");

    // Replace the plan while that day is half practiced (the thread page's Replace plan): the old day ends, and the new plan's Day 1 is the only open day.
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await page.getByRole("button", { name: PRACTICE_COPY.threadPageReplace }).click();
    const replace = page.getByRole("dialog", { name: /^New plan for/ });
    await fillNewPlan(replace, { replace: true });
    await replace.getByRole("button", { name: START_BUTTON }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 90_000 });
    await openFirstDay(page);
    const fresh = page.url();
    expect(fresh).not.toBe(practiced);

    // The old day is over without the owner ending it: its own screen is the review, and it offers the next day.
    await page.goto(practiced);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();

    const read = await readThread(context, threadId);
    const ended = read.daily.at(-1)!;
    await openDesk(page, `/practice/thread?id=${threadId}`);
    const day = page.getByRole("region", { name: "Practice day" });
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(formatBalance(read.thread.stats.balance));
    await expect(day).toContainText("Last day");
    await expect(day).toContainText(`${formatDayResult(ended.pnl_usd)} realized · 1 practice trade`);
    await expect(day).not.toContainText("0 practice trades");
    // D-047: the replaced plan's half-practiced day was the thread's Day 1, so the new plan's first day is the thread's Day 2.
    const plan = page.getByRole("region", { name: "Daily list plan" });
    await expect(plan).toContainText("Day 2 · list ready");
    await expect(plan).not.toContainText("in progress");

    // The thread page's Resume and the review's Next day open the same day.
    await day.getByRole("link", { name: /^Open Day 2$/ }).click();
    await page.waitForURL(fresh);
    await page.goto(practiced);
    await page.getByRole("button", { name: PRACTICE_COPY.dayAfter }).click();
    await page.waitForURL(fresh);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2");
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true })).toBeVisible();
  });

  // D-046: the review's Next day opens the next day on the server and the screens follow it in place, no reload: the day screen
  // reads the new day, and the landing (reached by its link, not by a page load) reads it too.
  test("Next day shows the day it opened, and the landing follows, without a reload", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    await openFirstDay(page);
    const dayOne = page.url();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5");

    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await page.getByRole("button", { name: PRACTICE_COPY.dayAfter }).click();
    await page.waitForURL((url) => /\/practice\/day\?id=\d+/.test(url.toString()) && url.toString() !== dayOne);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 5");
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true })).toBeVisible();
    const dayTwo = new URL(page.url());

    await page.getByRole("link", { name: "Practice", exact: true }).first().click();
    await page.waitForURL(/\/practice$/);
    // Day 2 is open: the row's Resume is its link.
    await expect(dayRow(page).getByRole("link", { name: /^Open Day 2$/ })).toHaveAttribute("href", `${dayTwo.pathname}${dayTwo.search}`);
  });

  // D-058: a slow open outlasts the gateway (524) while the server finishes it. The screen says it is still working, asks again,
  // and the second answer is the day; it never ends on "Couldn't open the list".
  test("Next day cut short by the gateway asks again and opens the day, saying it is still working", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    // The plan arms its filter (D-002, D-049): the thread page says what it armed.
    await expect(page.getByRole("region", { name: "Daily list plan" })).toContainText("Any close", { timeout: 60_000 });
    await openFirstDay(page);
    const dayOne = page.url();

    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    let cut = 0;
    await page.route("**/api/desk/replay/daily/next", async (route) => {
      if (cut === 0) {
        cut += 1;
        await route.fulfill({ status: 524, contentType: "text/html", body: "<html>A timeout occurred</html>" });
      } else await route.continue();
    });
    await page.getByRole("button", { name: PRACTICE_COPY.dayAfter }).click();
    await expect(page.getByText(PRACTICE_COPY.planStillWorking)).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.planStartError)).toHaveCount(0);
    await page.waitForURL((url) => /\/practice\/day\?id=\d+/.test(url.toString()) && url.toString() !== dayOne, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 5");
    expect(cut).toBe(1);
  });

  // D-058 on the modal: the save of a new plan is not safe to send twice, so when the gateway cuts it short (the server went on and
  // saved it) the modal waits until the new plan shows, continues it with a plain open, says it is still working, and lands on the thread page.
  test("Start cut short by the gateway waits for the plan, says it is still working, and lands on the thread page", async ({ page, context }) => {
    test.setTimeout(180_000);
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog);
    let cut = 0;
    await page.route("**/api/desk/replay/daily/next", async (route) => {
      if (cut === 0) {
        cut += 1;
        await route.fetch(); // the server takes the plan and does its work; only the browser's answer is lost
        await route.fulfill({ status: 524, contentType: "text/html", body: "<html>A timeout occurred</html>" });
      } else await route.continue();
    });
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    await expect(dialog.getByText(PRACTICE_COPY.planStillWorking)).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.newPlanError)).toHaveCount(0);
    await page.waitForURL(THREAD_URL, { timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Daily list plan" })).toContainText("Day 1 of 5", { timeout: 60_000 });
    expect(cut).toBe(1);
    expect(((await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as unknown[]).length, "one thread, not two").toBe(1);
  });

  // D-001: a filter that reads bars of the list day itself cannot be listed before its first bar has closed.
  test("the plan form moves the list time for a 15-minute filter, disables earlier times and says why", async ({ page }) => {
    const daily = await openNewPlan(page);
    const filters = daily.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true });
    const listTimes = daily.getByRole("radiogroup", { name: PRACTICE_COPY.planListAt, exact: true });
    const premarket = listTimes.getByRole("radio", { name: /^8:30/ });
    const tenOclock = listTimes.getByRole("radio", { name: /^10:00/ });

    await filters.getByRole("checkbox", { name: "Gap up" }).check();
    await expect(premarket).toBeChecked(); // a premarket filter lists at 8:30

    await filters.getByRole("checkbox", { name: "Abnormal volume" }).check();
    await expect(tenOclock).toBeChecked(); // the default suggestion for an intraday filter
    await expect(premarket).toBeDisabled();
    // D-017, M-02: 10:00 satisfies the filter, so the time she has is not called wrong; the reason for the disabled earlier time is in view, not in a tooltip, and Start is ready.
    await expect(daily.getByRole("alert")).toHaveCount(0);
    await expect(daily.getByText("Abnormal volume needs a list time of 10:00 AM or later · before then none of its bars of the day has closed")).toBeVisible();
    await expect(daily.getByRole("button", { name: START_BUTTON })).not.toHaveAttribute("aria-disabled", "true");
    await expect(daily.getByLabel(PRACTICE_COPY.planWindowFrom, { exact: true })).toHaveValue("10:00"); // the window starts at the list

    await filters.getByRole("checkbox", { name: "Abnormal volume" }).uncheck();
    await expect(premarket).not.toHaveAttribute("aria-disabled", "true");
    await expect(daily.getByText(/needs a list time of/)).toHaveCount(0);
    await tenOclock.click(); // Gap up needs 8:30: 10:00 holds, and nothing says it needs 8:30
    await expect(daily.getByText(/needs a list time of/)).toHaveCount(0);
    await expect(daily.getByRole("button", { name: START_BUTTON })).not.toHaveAttribute("aria-disabled", "true");
    await expectCleanScreen(page);
  });

  test("the server refuses a 15-minute filter at an 8:30 list with a 422 naming the list time", async ({ context }) => {
    const listed = await (await context.request.get(`${origin}/api/desk/screener/filters`)).json();
    const volume = (listed as Array<{ id: number; name: string }>).find((filter) => filter.name === "Abnormal volume");
    expect(volume).toBeDefined();
    const plan = (listAt: string, from: string) => ({
      plan: {
        schemaVersion: 1,
        firstDay: DAY,
        sessions: 5,
        hideDates: "yes",
        screen: { filters: [{ id: volume!.id }], listAt, maxList: 30 },
        setup: {
          window: { from, to: "11:30" },
          session: "regular",
          interval: "5m",
          shares: 100,
          armed: [],
          plan: { stopRequired: "no", signalOnly: "no" },
        },
      },
    });
    // Without a thread a new plan has nothing to book into: a plain 409 (02r), and nothing is saved.
    const unthreaded = await context.request.post(`${origin}/api/desk/replay/daily/next`, { data: plan("10:00", "10:00") });
    expect(unthreaded.status()).toBe(409);
    expect((await unthreaded.json()).detail.problems).toEqual([{ path: "threadId", message: PRACTICE_COPY.threadNeeded }]);
    const thread = await context.request.post(`${origin}/api/desk/replay/threads`, {
      data: { schemaVersion: 1, mode: "day", startingBalance: 50000, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } },
    });
    expect(thread.ok()).toBeTruthy();
    const second = await context.request.post(`${origin}/api/desk/replay/threads`, {
      data: { schemaVersion: 1, mode: "day", startingBalance: 50000, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } },
    });
    expect(second.ok(), "several active day threads are allowed").toBeTruthy();
    const refused = await context.request.post(`${origin}/api/desk/replay/daily/next`, { data: plan("08:30", "09:30") });
    expect(refused.status()).toBe(422);
    const { detail } = await refused.json();
    expect(detail.problems).toEqual([
      {
        path: "screen.listAt",
        message: "Abnormal volume needs a list time of 10:00 AM or later · before then none of its bars of the day has closed",
      },
    ]);
    expect((await context.request.get(`${origin}/api/desk/replay/daily`)).ok()).toBeTruthy();
    expect((await (await context.request.get(`${origin}/api/desk/replay/daily`)).json()).plan).toBeNull(); // nothing was saved
  });

  test("the bare day route with no open day says so and links back to Practice", async ({ page }) => {
    await openDesk(page, "/practice/day");
    await expect(page.getByText(PRACTICE_COPY.dayNoPlan)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Practice" })).toBeVisible();
    await expectCleanScreen(page);
  });
});

// Fix wave 5S, stream 1: the day list.
test.describe("Practice day list · fix wave 5S", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  /** A day thread's Day 1 list open on the stub day (one candidate: TSLA). */
  async function openDayList(page: Page, context: BrowserContext) {
    await startThread(page, context);
    await openFirstDay(page);
    await expect(page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ })).toBeVisible();
  }

  test("clicking a candidate row opens its practice chart, from the mouse and from the keyboard", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
    const row = page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ });
    await row.getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy", exact: true }).first()).toBeEnabled();
    // The same from the keyboard: focus the row on the list, then Enter.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  });

  test("the portfolio reflects a new held position, in the replay and on the Portfolio tab, never on the day list", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    await openFirstDay(page);
    const dayUrl = page.url();
    const portfolioOf = async () =>
      test.info().project.name === "desktop-1180"
        ? (async () => {
            const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.dayPortfolio });
            if (!(await drawer.isVisible())) await page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio }).click();
            return drawer;
          })()
        : page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
    await page.getByRole("table", { name: "Candidates" }).getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await page.keyboard.press("ArrowRight");
    const flat = await portfolioOf();
    await expect(flat.locator('[data-symbol="TSLA"]')).toContainText("Flat");
    await page.keyboard.press("b");
    await expect(flat.locator('[data-symbol="TSLA"]')).toContainText(/Long \d+ @ \$/);
    await expect(flat.getByTestId("portfolio-total")).toContainText(PRACTICE_COPY.dayPortfolioTotal);
    const held = ((await flat.locator('[data-symbol="TSLA"]').textContent()) ?? "").match(/Long \d+ @ \$[\d,.]+/)![0];
    // Back to the day list: it shows the list of names only, no portfolio section and no Portfolio tab in the right rail.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Day context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio })).toHaveCount(0);
    // The Portfolio subtab holds the same row and a day total.
    await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: "Portfolio", exact: true }).click();
    await page.waitForURL(/\/practice\/thread\?id=\d+&tab=portfolio/);
    const onTab = page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
    await expect(onTab.locator('[data-symbol="TSLA"]')).toContainText(held);
    await expect(onTab.getByTestId("portfolio-total")).toContainText(PRACTICE_COPY.dayPortfolioTotal);
  });

  test("no star or names cap anywhere on the day page", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
    await expect(page.getByRole("button", { name: /star/i })).toHaveCount(0);
    await expect(page.getByTestId("names-today")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/Starred \d+ of|names practiced today|names a day|limits a day/i);
  });

  test("the Open action of a listed name is visible without a hover and sits inside the scroller's visible width (D-090)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
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
    await page.waitForURL(SESSION_URL);
  });

  test("End day: the confirm takes focus without moving the table, Escape cancels and returns focus, and after it ends the review is in view and the keyboard lands on Next day (D-091, D-092, D-093, D-098, D-137)", async ({ page, context }) => {
    test.setTimeout(180_000);
    const api = watchApi(page);
    await openDayList(page, context);
    await expect(page.getByRole("heading", { level: 1 }), "D-093: the keyboard arrives at the page heading").toBeFocused();
    const table = page.getByRole("table", { name: "Candidates" });
    const top = (await table.boundingBox())!.y;
    const trigger = page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const confirm = page.getByRole("group", { name: "Confirm ending the day" });
    await expect(confirm.getByRole("button", { name: PRACTICE_COPY.dayEndYes }), "D-092: focus moves into the confirm").toBeFocused();
    expect((await table.boundingBox())!.y, "D-137: the confirm does not push the table down").toBe(top);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }), "one button is named End day").toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(trigger, "Escape returns focus to the trigger").toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await page.keyboard.press("Enter"); // Yes, end day
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayAfter }), "D-093: focus lands on the control that replaces End day").toBeFocused();
    // D-091: the stale candidates table is gone, the review is on screen, and the universe paragraph is said once.
    await expect(page.getByRole("table", { name: "Candidates" })).toHaveCount(0);
    const review = page.getByRole("region", { name: PRACTICE_COPY.reviewTitle });
    await expect(review).toBeInViewport();
    await expect(page.getByText(/Practice universe|^Universe: today's Desk set/)).toHaveCount(1);
    // D-098: a finished day's names are inert: no button to peek, and no peek request from a click on a symbol.
    await expect(page.getByRole("button", { name: "Peek at TSLA" })).toHaveCount(0);
    api.clear();
    await review.getByRole("table", { name: PRACTICE_COPY.reviewTitle }).getByText("TSLA", { exact: true }).click();
    await page.waitForTimeout(400);
    expect(api.paths().filter((path) => /[?&]peek=/.test(path)), "no peek request on an ended day").toEqual([]);
  });

  test("a day with no matching name says one plain sentence and offers Skip this day and Change plan; skipping it leaves one empty block (D-091, D-094)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("button", { name: PRACTICE_COPY.dayEndYes }).click();
    await page.getByRole("button", { name: PRACTICE_COPY.dayAfter }).click(); // Day 2 has no stored bars: its list is empty
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 5");
    await expect(page.getByText(PRACTICE_COPY.dayNoMatchTitle)).toBeVisible();
    await expect(page.getByText(/\bof \d+ matched\b/), "one count model: the third count is gone").toHaveCount(0);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayRescan }), "the dead Re-scan is not offered").toHaveCount(0);
    const hint = (await page.getByText(PRACTICE_COPY.dayNoMatchHint).boundingBox())!;
    const skip = (await page.getByRole("button", { name: PRACTICE_COPY.daySkip }).boundingBox())!;
    expect(skip.y - (hint.y + hint.height), "the hint does not touch the buttons under it").toBeGreaterThanOrEqual(8);
    await expect(page.getByRole("link", { name: /widen a filter/ }), "the Screener cannot edit this thread's plan").toHaveCount(0);
    await page.getByRole("button", { name: PRACTICE_COPY.dayChangePlan }).click();
    await expect(page.getByRole("dialog", { name: /^New plan for / })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: PRACTICE_COPY.daySkip }).click();
    // Skipping ends the day, so it asks first, as End day does (F-11): Keep practicing leaves the empty block, the yes ends it.
    const confirmSkip = page.getByRole("group", { name: "Confirm skipping the day" });
    await expect(confirmSkip).toContainText(PRACTICE_COPY.daySkipWarning);
    await confirmSkip.getByRole("button", { name: PRACTICE_COPY.dayKeepPracticing }).click();
    await expect(confirmSkip).toHaveCount(0);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.daySkip })).toBeFocused();
    await page.getByRole("button", { name: PRACTICE_COPY.daySkip }).click();
    await page.getByRole("group", { name: "Confirm skipping the day" }).getByRole("button", { name: PRACTICE_COPY.daySkipYes }).click();
    const review = page.getByRole("region", { name: PRACTICE_COPY.reviewTitle });
    await expect(review).toBeVisible();
    await expect(page.getByRole("table", { name: "Candidates" })).toHaveCount(0);
    await expect(review.getByText(PRACTICE_COPY.reviewEmpty), "one empty block, not four").toHaveCount(1);
    await expect(review.getByText(PRACTICE_COPY.reviewDayNone)).toHaveCount(0);
    await expect(page.getByText(/Practice universe|^Universe: today's Desk set/), "the universe paragraph is said once").toHaveCount(1);
  });

  test("the day page names no cap anywhere, and the last day ends on Finish plan, a summary and Start a new plan (D-096)", async ({ page, context }) => {
    test.setTimeout(240_000);
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog, {});
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    const threadId = Number(new URL(page.url()).searchParams.get("id"));
    await expect(page.getByRole("heading", { level: 1 }), "D-093: New plan submit lands with the heading focused").toBeFocused();
    await openFirstDay(page);
    // Practice = portfolio: no star and no count of names anywhere on the day page.
    await expect(page.getByRole("button", { name: /star/i })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/Starred \d+ of|names practiced today|names a day|limits a day/i);

    // Days 1 to 4 by API; Day 5 is the plan's last.
    let list = Number(new URL(page.url()).searchParams.get("id"));
    for (let day = 1; day <= 4; day++) {
      await send(context, "POST", `/day-lists/${list}/end`);
      list = await openNextDay(context, threadId);
    }
    await openDesk(page, `/practice/day?id=${list}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 5 of 5");
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("button", { name: PRACTICE_COPY.dayEndYes }).click();
    // D-096: no "Next day" that silently goes to /practice: the button says Finish plan and opens the thread's summary.
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayAfter })).toHaveCount(0);
    await page.getByRole("link", { name: PRACTICE_COPY.dayFinishPlan }).click();
    await page.waitForURL(`**/practice/thread?id=${threadId}`);
    const step = page.getByRole("region", { name: "Practice day" });
    await expect(step).toContainText(/Plan finished · 5 days · .* · win rate/);
    await expect(step.getByRole("button", { name: PRACTICE_COPY.landingNeedsPlan })).toBeVisible();
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText("Finished");
    await openDesk(page, "/practice");
    const row = dayRow(page);
    await expect(row).toContainText(PRACTICE_COPY.landingProgressFinished);
    await expect(row).not.toContainText("Day 5 done");
    await expect(row.getByRole("button", { name: "Start a new plan" })).toBeVisible();
  });

  test("the day list's left rail carries only the block's days, with no portfolio at 1440 or at 1180, and the block's days stay open for a short block (D-097)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog, { days: "10" }); // the stub day cannot start a 20-day block: it would run past the last finished day
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    await openFirstDay(page);
    const side = page.getByRole("complementary", { name: "Practice side panel" });
    const block = side.locator("details").filter({ hasText: "This block · 10 days" });
    await expect(block, "ten days or fewer start open").toHaveAttribute("open", "");
    await expect(page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio }), "the portfolio is the Portfolio tab's").toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Day context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio })).toHaveCount(0);
  });

  test("a day that is not chosen and one that is not found say different things, and a journal with no thread says one thing (D-116, D-117)", async ({ page }) => {
    await openDesk(page, "/practice/day");
    await expect(page.getByText(PRACTICE_COPY.dayNoPlan)).toBeVisible();
    for (const bad of ["abc", "999999"]) {
      await openDesk(page, `/practice/day?id=${bad}`);
      await expect(page.getByText(PRACTICE_COPY.dayNotFound), bad).toBeVisible();
      await expect(page.getByText(PRACTICE_COPY.dayNoPlan), bad).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open Practice" })).toBeVisible();
    }
    await openDesk(page, "/practice/journal");
    await expect(page.getByText(PRACTICE_COPY.threadPickNone)).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.threadPickTitle), "one statement, not two stacked").toHaveCount(0);
    await expect(page.getByRole("link", { name: PRACTICE_COPY.openPractice }), "and the way forward is one primary link").toBeVisible();
  });

  test("while the day list loads the page shows its own shape and says it is busy (D-116)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
    const url = page.url();
    await page.route(/\/api\/desk\/replay\/day-lists\/\d+/, async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.goto(url);
    await expect(page.locator('[role="status"][aria-busy="true"]')).toBeVisible();
    await expect(page.getByRole("table", { name: "Candidates" })).toBeVisible();
  });

  test("the day's title is the day and weekday, with the page kind as a chip (D-139)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Day 1 of 5 · Fri");
    await expect(page.getByText("Practice day list", { exact: true })).toBeVisible();
  });

  test("the journal's passed-day box holds its whole label clear of the zero line (D-125)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await openDayList(page, context);
    const daily = (await (await context.request.get(`${origin}/api/desk/replay/daily`)).json()) as { plan: { thread_id: number; current: { id: number } } };
    await send(context, "POST", `/day-lists/${daily.plan.current.id}/end`); // ended with no session: a passed day
    const threadId = daily.plan.thread_id;
    await openDesk(page, `/practice/journal?thread=${threadId}`);
    const chart = page.getByRole("img", { name: /^Result of each day/ });
    await expect(chart).toBeVisible();
    const fit = await chart.evaluate((svg) => {
      const label = [...svg.querySelectorAll("text")].find((text) => text.textContent === "Passed")!;
      const box = svg.querySelector("rect[class*=skipBox]")!.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      const zero = svg.querySelector("line[class*=zeroLine]")!.getBoundingClientRect();
      return { padLeft: text.left - box.left, padRight: box.right - text.right, clearOfZero: text.bottom <= zero.top + 1 };
    });
    expect(fit.padLeft, "room on the left").toBeGreaterThanOrEqual(3);
    expect(fit.padRight, "room on the right").toBeGreaterThanOrEqual(3);
    expect(fit.clearOfZero, "the $0 line does not cut through the label").toBe(true);
  });
});
