import type { BrowserContext, Page } from "@playwright/test";
import { formatEtDay } from "../../lib/desk/format.ts";
import { formatBalance, formatDayResult } from "../../lib/replay/threadView.ts";
import { PRACTICE_COPY, practiceBandText, practiceText } from "../../lib/desk/freshness.ts";
import { defaultDraft, draftToSpec, type SetupDraft } from "../../lib/replay/setup.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";
import { DAY, THREAD_URL, clickNewPlan, createStubSession, createThreadByApi, fillNewPlan, openFirstDay, openNewPlan, openRow, saveFilter, startThread } from "./hub-helpers";
import { replayRail } from "./swing-helpers";

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

const playhead = (page: Page) => page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd");
const marksTab = (page: Page) => page.getByRole("tab", { name: "Marks" });

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
    await expectCleanScreen(page);

    expect((await page.request.get(`${origin}/favicon.ico`)).ok(), "D-010: the export ships a favicon").toBeTruthy();

    await startStubSession(page, context);
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
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
    await expect(page.getByText("Playing · 10x")).toBeVisible(); // D-025: the player's state as a pill in the header
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
    await marksTab(page).click();
    const marks = page.getByRole("tabpanel");
    await expect(marks).toContainText("Practice long");

    // T opens the stop note; Enter saves it.
    await page.keyboard.press("t");
    const stop = page.getByRole("form", { name: "Stop note" });
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
    await page.keyboard.press("s"); // the opposite key exits an open long
    await expect(marks).toContainText("Practice exit");
    await expectCleanScreen(page);

    // Ending early asks first, then scores and opens the journal.
    await page.getByRole("button", { name: "End session…" }).click();
    await expect(page.getByText(PRACTICE_COPY.endEarlyWarning)).toBeVisible();
    await page.getByRole("button", { name: PRACTICE_COPY.endAndScore }).click();
    await page.waitForURL(JOURNAL_URL);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Practice journal");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA");
    await expect(page.getByRole("listitem").filter({ hasText: /^Trades/ })).toContainText("1");
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
    await page.getByRole("menuitem", { name: /^To the window end/ }).click();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.endAndScore })).toBeVisible();
    await expect(page.getByText(/^Session over/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
    await expectCleanScreen(page);

    await page.getByRole("button", { name: PRACTICE_COPY.endAndScore }).click();
    await page.waitForURL(JOURNAL_URL);
    await expect(page.getByText(PRACTICE_COPY.noTradesJournal).first()).toBeVisible();
    await expectCleanScreen(page);
  });

  // Daily-list practice (02o-b v1): the plan, the day list before the open, Peek, stars, one practice session, the end of
  // the day and its review, then the next day. The stub holds TSLA on Fri 2026-09-25 only, so Day 1 lists TSLA through her
  // own always-matching daily filter and Day 2 lists nothing; the plan's data is fetched in the background first.
  test("a daily plan opens a hidden-date day list with Peek and stars, ends into the review, and Continue opens Day 2", async ({ page, context }) => {
    test.setTimeout(180_000);
    const answers = watchReplayAnswers(page);
    const api = watchApi(page);
    await saveFilter(context); // her own always-matching daily filter; TSLA only: the fixture's stand-in names trade below $200

    // The landing's New plan modal starts the thread (its risk plan: a $600 daily loss, at most 3 trades) and its plan in one go.
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog, { maxLoss: "600", maxTrades: "3", note: "Trade only clean pullbacks.", stop: true });
    await expectCleanScreen(page);
    await expect(dialog.getByText("Arm up to 5 strategies · 1 armed")).toBeVisible(); // D-002: the picked filter is armed for her
    await expect(dialog.getByRole("button", { name: "Save plan" })).toHaveCount(0); // D-003: the button says what it does
    await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true }).click();

    // The thread page: prep runs once in the background; Day 1 opens when the data is ready.
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    const threadId = Number(new URL(page.url()).searchParams.get("id"));
    const planCard = page.getByRole("region", { name: "Daily list plan" });
    await expect(planCard).toContainText("Day 1 of 5 · next: Fri", { timeout: 60_000 });
    await expect(planCard).toContainText("Armed on practice days: Any close"); // D-002: the card says what the modal armed
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(formatBalance(50_000));
    await expect(page.locator("body")).not.toContainText(DAY);
    await expectCleanScreen(page);
    await openFirstDay(page);
    const dayUrl = page.url();

    // D-004: the bare route finds the day she has open.
    await openDesk(page, "/practice/day");
    await page.waitForURL(dayUrl);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5 · Fri · Practice day list");

    // The day list: dates hidden, the candidate, the universe line, and the footnote.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5 · Fri · Practice day list");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY, true, true));
    await expect(page.getByText(/^List built at 8:30 AM ET from data through 8:15 AM/)).toBeVisible();
    await expect(page.getByText(/Universe: today's Desk set, up to 250 names by today's dollar volume \(\d+ names here\)/).first()).toBeVisible();
    const table = page.getByRole("table", { name: "Candidates" });
    await expect(table.getByRole("row", { name: /TSLA/ })).toBeVisible();
    // D-013, D-014, D-018: the P7 layout (the block, the thread and the stars on the left), the chips read as on, the P7 columns.
    const left = page.getByRole("complementary", { name: "Practice side panel" });
    await expect(left).toContainText("This block · 5 days");
    await expect(left).toContainText("Risk plan comes from the thread: ");
    await expect(page.getByRole("list", { name: "Filters" }).getByRole("listitem").first()).toHaveAttribute("data-active", "true");
    await expect(page.getByText("Chosen at setup")).toBeVisible();
    for (const label of ["Prev close", "Prev RVOL", "Prev change %", "Earnings"]) await expect(table.getByRole("columnheader", { name: label })).toBeVisible();
    // D-043: the day list's own status line.
    await expect(page.getByLabel("Status")).toContainText("Day lists built before the open");
    await expect(page.getByLabel("Status")).toContainText("List built 8:30 AM ET");
    await expect(page.locator("body")).not.toContainText(DAY);
    await expectCleanScreen(page);

    // Peek: the chart before the open; a star keeps the name in view.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "TSLA", level: 3 })).toBeVisible();
    await expect(page.getByRole("tab", { name: PRACTICE_COPY.dayPeekToday })).toBeVisible(); // D-019: no "Today so far" on a replay day
    await expect(page.getByText("Today so far")).toHaveCount(0);
    await page.getByRole("button", { name: "Star TSLA" }).click();
    await expect(page.getByRole("button", { name: "Unstar TSLA" })).toBeVisible();
    await expectCleanScreen(page);

    // Practice the name: the workspace opens at the window start, with a way back to the list.
    await page.getByRole("button", { name: "Practice TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToList })).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToPractice })).toHaveAttribute("href", /^\/practice\/thread\?id=\d+$/);
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
    // D-060: the plan asks for a stop on every entry, so B without a stop price is refused in plain words and nothing is placed.
    await page.keyboard.press("b");
    await expect(page.getByRole("alert").filter({ hasText: PRACTICE_COPY.stopFirst })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss message" }).click();
    const practice = await replayRail(page, "Practice");
    await expect(practice.getByRole("button", { name: "Long (B)" })).toBeDisabled(); // the buttons wait for the stop price too
    await practice.getByLabel("Stop price (required)").fill("100");
    await practice.getByRole("button", { name: "Long (B)" }).click();
    // D-060: Stop (T) places the stop typed in the field; no second form to save.
    await practice.getByLabel("Stop price").fill("150");
    await practice.getByRole("button", { name: "Stop (T)" }).click();
    await marksTab(page).click();
    await expect(page.getByRole("tabpanel")).toContainText("Practice stop");
    await expect(page.getByRole("tabpanel")).toContainText("Practice long");
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
    await expect(review.getByRole("table", { name: "Your practice trades" })).toBeVisible(); // D-032: a line per trade
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
    await dayRow(page).getByRole("button", { name: PRACTICE_COPY.planResume, exact: true }).click();
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 5 · Mon");
    await expect(page.getByText(PRACTICE_COPY.dayNoNames).first()).toBeVisible();
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
    await expect(page.getByRole("img", { name: /^Result of each day.*1 skipped\.$/ })).toBeVisible();
    const tile = (label: string) => page.getByRole("listitem").filter({ hasText: new RegExp(`^${label}`) });
    await expect(tile("Days practiced")).toContainText("of 2 days opened");
    await expect(tile("Skipped")).toContainText("balance carried over");
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
    await expect(closedRow.getByRole("button", { name: PRACTICE_COPY.planResume })).toHaveCount(0);
    await expect(closedRow.getByRole("link", { name: PRACTICE_COPY.landingJournal, exact: true })).toBeVisible(); // a closed thread's one action
    const again = await clickNewPlan(page);
    await expect(again.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toBeEnabled();
    await expect(again.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toHaveAttribute("aria-pressed", "true");
    await expectCleanScreen(page);
  });

  test("a new thread's journal says there are no days yet, and a thread that does not exist says it could not load", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    await openDesk(page, "/practice");
    const card = dayRow(page);
    await expect(card).toContainText(PRACTICE_COPY.landingNeedsPlan); // no daily plan yet: nothing to resume
    await expect(card.getByRole("button", { name: PRACTICE_COPY.planResume })).toHaveCount(0);
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
    await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true }).click();
    const bounds = dialog.getByRole("alert").filter({ hasText: "1,000" });
    await expect(bounds).toContainText("10,000,000");
    await expect(dialog).toBeVisible(); // nothing was created
    await page.keyboard.press("Escape");

    await startThread(page, context, { balance: "25000", filter: "Any close" });
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText("Started with $25,000");
    const listed = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { startingBalance: number; stats: { balance: number } } }>;
    expect([listed[0]!.thread.startingBalance, listed[0]!.thread.stats.balance]).toEqual([25000, 25000]);

    // The server allows several active threads per mode, so the modal keeps both segments on and Day can start another thread.
    await openDesk(page, "/practice");
    const again = await clickNewPlan(page);
    await expect(again.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toBeEnabled();
    await expect(again.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toHaveAttribute("aria-pressed", "true");
    await expect(again.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toBeEnabled();
    await expect(again).not.toContainText("is already active");
    await expect(again.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true })).toBeVisible();
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
    await page.getByRole("button", { name: "Practice TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).not.toContainText("9:30:00");
    await page.keyboard.press("b");
    await marksTab(page).click();
    await expect(page.getByRole("tabpanel")).toContainText("Practice long");
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("x");
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");

    // Replace the plan while that day is half practiced (the thread page's Replace plan): the old day ends, and the new plan's Day 1 is the only open day.
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await page.getByRole("button", { name: PRACTICE_COPY.threadPageReplace }).click();
    const replace = page.getByRole("dialog", { name: /^New plan for/ });
    await fillNewPlan(replace, { replace: true });
    await replace.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true }).click();
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
    await expect(plan).toContainText("Day 2 · plan day 1 of 5 · list ready");
    await expect(plan).not.toContainText("in progress");

    // The thread page's Resume and the review's Next day open the same day.
    await day.getByRole("link", { name: PRACTICE_COPY.planResume, exact: true }).click();
    await page.waitForURL(fresh);
    await page.goto(practiced);
    await page.getByRole("button", { name: PRACTICE_COPY.dayAfter }).click();
    await page.waitForURL(fresh);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 · plan day 1 of 5");
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
    await expect(dayRow(page).getByRole("link", { name: PRACTICE_COPY.planResume, exact: true })).toHaveAttribute("href", `${dayTwo.pathname}${dayTwo.search}`);
  });

  // D-058: a slow open outlasts the gateway (524) while the server finishes it. The screen says it is still working, asks again,
  // and the second answer is the day; it never ends on "Couldn't open the list".
  test("Next day cut short by the gateway asks again and opens the day, saying it is still working", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    // The plan arms its filter (D-002, D-049): the thread page says what it armed.
    await expect(page.getByRole("region", { name: "Daily list plan" })).toContainText("Armed on practice days: Any close", { timeout: 60_000 });
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
  test("Populate data cut short by the gateway waits for the plan, says it is still working, and lands on the thread page", async ({ page, context }) => {
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
    await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true }).click();
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
    const listTimes = daily.getByRole("group", { name: PRACTICE_COPY.planListAt, exact: true });
    const premarket = listTimes.getByRole("button", { name: /^8:30/ });
    const tenOclock = listTimes.getByRole("button", { name: /^10:00/ });

    await filters.getByRole("checkbox", { name: "Gap up" }).check();
    await expect(premarket).toHaveAttribute("aria-pressed", "true"); // a premarket filter lists at 8:30
    await expect(daily.getByText("Arm up to 5 strategies · 1 armed")).toBeVisible();

    await filters.getByRole("checkbox", { name: "Abnormal volume" }).check();
    await expect(tenOclock).toHaveAttribute("aria-pressed", "true"); // the default suggestion for an intraday filter
    await expect(premarket).toBeDisabled();
    // D-017: 10:00 satisfies the filter, so no line says otherwise; the reason sits on the disabled earlier time, and Populate data is ready.
    await expect(daily.getByText(/needs a list time of/)).toHaveCount(0);
    await expect(daily.getByRole("alert")).toHaveCount(0);
    await expect(premarket).toHaveAttribute("title", "Abnormal volume needs a list time of 10:00 AM or later · before then none of its bars of the day has closed");
    await expect(daily.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true })).toBeEnabled();
    await expect(daily.getByText("Arm up to 5 strategies · 2 armed")).toBeVisible();
    await expect(daily.getByLabel("From", { exact: true })).toHaveValue("10:00"); // the window starts at the list

    await filters.getByRole("checkbox", { name: "Abnormal volume" }).uncheck();
    await expect(premarket).toBeEnabled();
    await expect(daily.getByText("Arm up to 5 strategies · 1 armed")).toBeVisible(); // dropping a filter disarms it
    await tenOclock.click(); // Gap up needs 8:30: 10:00 holds, and nothing says it needs 8:30
    await expect(daily.getByText(/needs a list time of/)).toHaveCount(0);
    await expect(daily.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true })).toBeEnabled();
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
