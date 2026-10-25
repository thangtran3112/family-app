import type { BrowserContext, Page } from "@playwright/test";
import { formatEtDay } from "../../lib/desk/format.ts";
import { formatBalance, formatDayResult } from "../../lib/replay/threadView.ts";
import { PRACTICE_COPY, practiceBandText, practiceText } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";

// The Practice lane (02o §i, step 5): hub to start, play, step, B, T, S/X, end, the journal, and a resumed session.
// The backend runs with `DESK_REPLAY_STUB=1` (`replay/fixture.py`): the one replayable day is TSLA on Fri 2026-09-25
// and the tape holds its first ten minutes after the open, so every session here replays 09:30 to 09:40 ET.

const DAY = "2026-09-25";
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

/** Fill the hub with the stub day and start. `from`/`to` default to the stub's ten minutes of tape. */
async function startStubSession(page: Page) {
  await openDesk(page, "/practice");
  const form = page.locator("#start-practice");
  await form.getByRole("combobox").fill("TSLA");
  await form.locator('input[type="date"]').fill(DAY);
  await form.getByLabel("To", { exact: true }).fill("09:40");
  await form.getByRole("button", { name: "1m", exact: true }).click();
  await form.getByRole("button", { name: "Start practice" }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
}

/** Start a practice thread from the hub (02r, D-007): the risk plan lives on the thread, not on the daily-list form. */
async function startThread(page: Page, plan: { balance?: string; maxLoss?: string; maxTrades?: string; note?: string } = {}) {
  await openDesk(page, "/practice");
  const threads = page.locator("#threads");
  const form = threads.getByRole("form", { name: "New thread" });
  await expect(form.getByLabel("Starting balance")).toHaveValue("50000");
  if (plan.balance) await form.getByLabel("Starting balance").fill(plan.balance);
  if (plan.maxLoss) await form.getByLabel("Max loss ($)").fill(plan.maxLoss);
  if (plan.maxTrades) await form.getByLabel("Max trades").fill(plan.maxTrades);
  if (plan.note) await form.getByLabel(/^Plan note/).fill(plan.note);
  await form.getByRole("button", { name: PRACTICE_COPY.threadSubmit }).click();
  await expect(threads.getByRole("article", { name: "Active practice thread" })).toContainText(plan.balance ? formatBalance(Number(plan.balance)) : "$50,000");
  return threads;
}

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

  test("the hub shows the Practice band, notable days with hidden dates, and starts the stub day", async ({ page }) => {
    const api = watchApi(page);
    await openDesk(page, "/practice");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(null));
    await expect(page.getByRole("heading", { name: "Start a practice session" })).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.notableHeader)).toBeVisible();
    // D-008: the session form keeps its session-scope controls; the risk plan is the thread's and is not asked again here.
    const session = page.locator("#start-practice");
    for (const label of ["Max loss ($)", "Max trades", "Plan note", "Shares", "Stop on every entry", "Trade only on a signal"]) {
      await expect(session.getByLabel(label)).toHaveCount(0);
      await expect(session.getByText(label, { exact: true })).toHaveCount(0);
    }
    await expect(session.getByRole("group", { name: "Plan", exact: true })).toHaveCount(0);
    await expect(session.getByRole("group", { name: "Window (ET)" })).toBeVisible();
    // Practice threads (02r): the band sits above the daily list; without a thread the daily list waits for one.
    await expect(page.getByRole("heading", { name: PRACTICE_COPY.threadsTitle })).toBeVisible();
    const newThread = page.locator("#threads").getByRole("form", { name: "New thread" });
    await expect(newThread.getByLabel("Starting balance")).toHaveValue("50000");
    // D-016: the starting balance is a real number field with the contract's bounds, live while no thread is active.
    await expect(newThread.getByLabel("Starting balance")).toHaveAttribute("type", "number");
    await expect(newThread.getByLabel("Starting balance")).toHaveAttribute("min", "1000");
    await expect(newThread.getByLabel("Starting balance")).toHaveAttribute("max", "10000000");
    await expect(newThread.getByLabel("Starting balance")).toBeEnabled();
    await expect(newThread.getByRole("button", { name: PRACTICE_COPY.threadSubmit })).toBeEnabled();
    await expect(newThread.getByRole("button", { name: "Day trading" })).toHaveAttribute("aria-pressed", "true");
    await expect(newThread.getByRole("button", { name: PRACTICE_COPY.threadModeSwing })).toBeDisabled();
    await expect(page.locator("#daily-list").getByText(PRACTICE_COPY.threadNeeded)).toBeVisible();
    await expect(page.locator("#daily-list").getByRole("form", { name: "Daily list plan" })).toHaveCount(0);

    // Dates stay masked until "Show dates" is on; the weekday is kept.
    const notable = page.locator("#notable-days");
    await expect(notable.getByText(PRACTICE_COPY.hiddenDay).first()).toBeVisible();
    await expect(notable).not.toContainText(/20\d\d-\d\d-\d\d/);
    await notable.getByRole("switch", { name: "Show dates" }).check();
    await expect(notable).toContainText(/20\d\d-\d\d-\d\d/);
    await expectCleanScreen(page);

    await startStubSession(page);
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expectCleanScreen(page);
    expect(api.paths().filter((path) => path === "POST /api/desk/replay/sessions")).toHaveLength(1);
    expect(api.paths().filter((path) => LIVE_DATA.test(path)), "a replay screen never reads the live store").toEqual([]);
  });

  test("arming a saved alert strategy starts a session that lists it", async ({ page }) => {
    await openDesk(page, "/practice");
    const form = page.locator("#start-practice");
    await form.getByRole("combobox").fill("TSLA");
    await form.locator('input[type="date"]').fill(DAY);
    await form.getByLabel("To", { exact: true }).fill("09:40");
    await form.getByRole("checkbox", { name: /^ORB 15m/ }).check();
    await expect(form.getByText("1 armed")).toBeVisible();
    await form.getByRole("button", { name: "Start practice" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    // The armed list lives in the left rail (1440) or its collapsed strip (1180); the session itself says what it armed.
    const answer = await page.request.get(page.url().replace(/\/practice\/replay\?id=/, "/api/desk/replay/sessions/"));
    const body = (await answer.json()) as { armed: Array<{ name: string; fires_so_far: number }> };
    expect(body.armed.map((item) => item.name)).toEqual(["ORB 15m"]);
    await expectCleanScreen(page);
  });

  test("a hidden notable day keeps its date off the screen", async ({ page }) => {
    await openDesk(page, "/practice");
    const notable = page.locator("#notable-days");
    await notable.getByRole("button", { name: /^Practise TSLA$/ }).first().click();
    await expect(page.locator("#start-practice")).toContainText(PRACTICE_COPY.hiddenDay);
    await expect(page.locator("#start-practice").locator('input[type="date"]')).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("a day with no stored trades says so on the hub instead of opening a session", async ({ page }) => {
    await openDesk(page, "/practice");
    const form = page.locator("#start-practice");
    await form.getByRole("combobox").fill("NVDA");
    await form.locator('input[type="date"]').fill("2026-09-24");
    await form.getByRole("button", { name: "Start practice" }).click();
    await expect(form.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/practice$/);
    await expectCleanScreen(page);
  });

  test("play moves the playhead, step moves it one bar, and the shortcuts overlay opens on ?", async ({ page }) => {
    const answers = watchReplayAnswers(page);
    await startStubSession(page);
    const clock = playhead(page);
    await expect(clock).toContainText("9:30");

    // Space plays; key 4 picks 10x. The clock only ever moves forward.
    await page.keyboard.press("4");
    await page.keyboard.press("Space");
    await expect(page.getByText(practiceText("playing", { speed: 10 }))).toBeVisible();
    await expect(clock).not.toContainText("9:30:00", { timeout: 10_000 });
    await page.keyboard.press("Space");
    await expect(page.getByText(/^Paused at /)).toBeVisible();

    const before = await clock.innerText();
    await page.keyboard.press("ArrowRight");
    await expect(clock).not.toHaveText(before);

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

  test("B, T and X place practice marks; undo removes the last one; End and score opens the journal with the trade", async ({ page }) => {
    await startStubSession(page);
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

  test("a resumed session restores the playhead; the hub offers Resume", async ({ page }) => {
    await startStubSession(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const clock = playhead(page);
    await expect(clock).not.toContainText("9:30:00");
    const placed = await clock.innerText();

    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(placed);

    await openDesk(page, "/practice");
    const sessions = await railSection(page, "Practice sessions", "Resume");
    const resume = sessions.getByRole("article", { name: "Active practice session" });
    await expect(resume).toContainText("TSLA");
    await resume.getByRole("link", { name: "Resume" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(playhead(page)).toHaveText(placed);
    await expectCleanScreen(page);
  });

  test("jump to the window end shows the end prompt, and the journal of an unfinished session stays open", async ({ page }) => {
    await startStubSession(page);
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
    const anyClose = {
      schemaVersion: 1,
      name: "Any close",
      watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
      liquidity: { minPrice: 1, minAvgVolume: 1 },
      when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
      maxResults: 50,
    };
    const created = await context.request.post(`${origin}/api/desk/screener/filters`, { data: { spec: anyClose } });
    expect(created.ok()).toBeTruthy();

    // The hub: start a thread first (its risk plan: a $600 daily loss, at most 3 trades), then the plan form, since there is no plan yet.
    const threads = await startThread(page, { maxLoss: "600", maxTrades: "3", note: "Trade only clean pullbacks." });
    const daily = page.locator("#daily-list");
    await expect(daily.getByRole("form", { name: "Daily list plan" })).toBeVisible();
    // D-007: the PLAN block left the daily form; the thread carries it.
    await expect(daily.getByRole("group", { name: "Plan", exact: true })).toHaveCount(0);
    for (const label of ["Max loss ($)", "Max trades", "Plan note", "Shares", "Stop on every entry", "Trade only on a signal"]) {
      await expect(daily.getByLabel(label)).toHaveCount(0);
    }
    await expect(daily.getByText(PRACTICE_COPY.threadPlanFrom)).toBeVisible();
    await daily.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: "Any close" }).check();
    await daily.locator('input[type="date"]').fill(DAY);
    await daily.getByRole("group", { name: "Days" }).getByRole("button", { name: "5", exact: true }).click();
    await daily.getByLabel("To", { exact: true }).fill("09:40");
    await daily.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: "1m", exact: true }).click();
    await expectCleanScreen(page);
    await expect(daily.getByText("Arm up to 5 strategies · 1 armed")).toBeVisible(); // D-002: the picked filter is armed for her
    await expect(daily.getByRole("button", { name: "Save plan" })).toHaveCount(0); // D-003: the button says what it does
    await daily.getByRole("button", { name: PRACTICE_COPY.planSubmit, exact: true }).click();

    // Prep runs once in the background; Day 1 opens when the data is ready.
    await expect(daily.getByRole("button", { name: PRACTICE_COPY.planStart })).toBeVisible({ timeout: 60_000 });
    await expect(daily).toContainText("Day 1 of 5 · next: Fri");
    await expect(daily).toContainText("Armed on practice days: Any close"); // D-002: the card says what the rail armed
    await expect(daily).not.toContainText(DAY);
    await expectCleanScreen(page);
    await daily.getByRole("button", { name: PRACTICE_COPY.planStart }).click();
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    const dayUrl = page.url();

    // D-004: the bare route finds the day she has open.
    await openDesk(page, "/practice/day");
    await page.waitForURL(dayUrl);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5 · Fri · Practice day list");

    // The day list: dates hidden, the candidate, the universe line, and the footnote.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5 · Fri · Practice day list");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY, true));
    await expect(page.getByText(/^List at 8:30 AM ET from data through 8:15 AM/)).toBeVisible();
    await expect(page.getByText(/Practice universe · \d+ symbols the Desk has scanned/).first()).toBeVisible();
    const table = page.getByRole("table", { name: "Candidates" });
    await expect(table.getByRole("row", { name: /TSLA/ })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(DAY);
    await expectCleanScreen(page);

    // Peek: the chart before the open; a star keeps the name in view.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "TSLA", level: 3 })).toBeVisible();
    await page.getByRole("button", { name: "Star TSLA" }).click();
    await expect(page.getByRole("button", { name: "Unstar TSLA" })).toBeVisible();
    await expectCleanScreen(page);

    // Practise the name: the workspace opens at the window start, with a way back to the list.
    await page.getByRole("button", { name: "Practise TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToList })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).not.toContainText("9:30:00");
    await expectCleanScreen(page);

    // The workspace carries the thread: its balance and today's result (SIMULATED), and the thread plan in the rail.
    const strip = page.getByRole("group", { name: "Practice thread" });
    await expect(strip).toContainText("Thread balance $50,000");
    await expect(strip).toContainText(PRACTICE_COPY.threadSimulated);
    // A practice trade: the exit mark books one ledger row, so the thread balance moves with it.
    await page.keyboard.press("b");
    await marksTab(page).click();
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

    // Continue: Day 2 has no stored TSLA bars, so its list is empty and says so.
    await openDesk(page, "/practice");
    await expect(page.locator("#daily-list")).toContainText("Day 2 of 5 · next: Mon");
    // D-035: the day that ended reads done on the hub, never "in progress".
    await expect(page.locator("#daily-list")).toContainText("Day 1 done");
    await expect(page.locator("#daily-list")).not.toContainText("in progress");
    // D-030: with no day open the thread card's row is the last ended day, the same ledger figure as the balance.
    const [firstThread] = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { id: number } }>;
    const afterDayOne = await readThread(context, firstThread!.thread.id);
    const activeCard = threads.getByRole("article", { name: "Active practice thread" });
    await expect(activeCard).toContainText("Last day");
    await expect(activeCard).toContainText(`${formatDayResult(afterDayOne.daily[0]!.pnl_usd)} realized · 1 practice trade`);
    await expect(activeCard).toContainText(formatBalance(afterDayOne.thread.stats.balance));
    await page.locator("#daily-list").getByRole("button", { name: PRACTICE_COPY.planContinue }).click();
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

    // The thread reads back from the ledger: one practised day, one skipped day, and the balance is the starting
    // balance plus the ledger rows (nothing stored twice).
    const listed = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { id: number } }>;
    expect(listed).toHaveLength(1);
    const threadId = listed[0]!.thread.id;
    const ledger = (await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}/ledger`)).json()) as { total: number; entries: Array<{ pnlUsd: number }> };
    expect(ledger.total).toBe(1);
    const read = await readThread(context, threadId);
    expect(read.thread.stats.balance).toBeCloseTo(50000 + ledger.entries[0]!.pnlUsd, 2);
    expect([read.thread.stats.daysPracticed, read.thread.stats.daysSkipped]).toEqual([1, 1]);
    expect(read.daily.map((day) => day.kind)).toEqual(["practiced", "skipped"]);
    expect(read.daily[1]!.balance, "a skipped day carries the balance").toBe(read.daily[0]!.balance);
    const balance = formatBalance(read.thread.stats.balance);

    // The hub card shows the balance; its journal opens from there.
    await openDesk(page, "/practice");
    const card = threads.getByRole("article", { name: "Active practice thread" });
    await expect(card).toContainText(balance);
    await expect(card).toContainText(PRACTICE_COPY.threadSimulated);
    await card.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
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
    await expectCleanScreen(page);

    // One practised day is too few for a trend, and the journal says so instead of guessing.
    const improvement = await railSection(page, "Thread details", PRACTICE_COPY.improvementTitle);
    await expect(improvement.getByText(PRACTICE_COPY.improvementTooFew)).toBeVisible();
    await expect(improvement.getByText(/^Reason: week 2 has no practice days so far/)).toBeVisible();

    // Edit the plan on the journal, then close the thread; the closed thread keeps its journal.
    const plan = await railSection(page, "Thread details", PRACTICE_COPY.threadPlanTitle);
    await expect(plan).toContainText("$600");
    await plan.getByRole("button", { name: PRACTICE_COPY.threadEditPlan }).click();
    await plan.getByLabel("Max loss ($)").fill("400");
    await plan.getByRole("button", { name: PRACTICE_COPY.threadSavePlan }).click();
    await expect(plan).toContainText("$400");
    await expect(plan.getByRole("button", { name: PRACTICE_COPY.threadSavePlan })).toHaveCount(0);
    await plan.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await plan.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(page.getByRole("status").filter({ hasText: "This thread is closed" })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance at the end of each day/ })).toBeVisible();
    await expect((await readThread(context, threadId)).thread.status).toBe("closed");
    await expectCleanScreen(page);

    // Back on the hub: the closed state in plain words, a new thread can start, and the daily list waits for it.
    await openDesk(page, "/practice");
    await expect(threads.getByRole("article", { name: "Closed practice thread" })).toContainText(PRACTICE_COPY.threadClosedTitle);
    await expect(threads.getByRole("button", { name: PRACTICE_COPY.threadStartNew })).toBeVisible();
    await expect(threads.getByRole("form", { name: "New thread" })).toBeVisible();
    await expect(page.locator("#daily-list").getByText(PRACTICE_COPY.threadNeeded)).toBeVisible();
    await expectCleanScreen(page);
  });

  test("a new thread's journal says there are no days yet, and a thread that does not exist says it could not load", async ({ page }) => {
    const threads = await startThread(page);
    const card = threads.getByRole("article", { name: "Active practice thread" });
    await expect(card).toContainText(PRACTICE_COPY.threadResumeNeedsPlan); // no daily plan yet: nothing to resume
    await card.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
    await expect(page.getByText("$50,000 · 0 days practiced")).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.journalThreadEmpty)).toBeVisible();
    await expect(page.getByRole("img", { name: /^Balance at the end of each day/ })).toHaveCount(0);
    await expectCleanScreen(page);

    await openDesk(page, "/practice/journal?thread=99999");
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load this thread" })).toBeVisible();
    await expectCleanScreen(page);
  });

  // D-009, D-016: the New thread form is always on screen. It is live with no thread and disabled, with the one-thread note and
  // a way to the journal, while one is active; the starting balance is a real number field and the typed value is kept.
  test("the New thread form stays on screen, disabled while a thread is active, and a custom starting balance is kept", async ({ page, context }) => {
    await openDesk(page, "/practice");
    const form = page.locator("#threads").getByRole("form", { name: "New thread" });
    await form.getByLabel("Starting balance").fill("500");
    await form.getByRole("button", { name: PRACTICE_COPY.threadSubmit }).click();
    await expect(form.getByRole("alert")).toContainText("1,000");
    await expect(form.getByRole("alert")).toContainText("10,000,000");

    const threads = await startThread(page, { balance: "25000" });
    await expect(threads.getByRole("article", { name: "Active practice thread" })).toContainText("Started with $25,000");
    const listed = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { startingBalance: number; stats: { balance: number } } }>;
    expect([listed[0]!.thread.startingBalance, listed[0]!.thread.stats.balance]).toEqual([25000, 25000]);

    await expect(form).toBeVisible();
    await expect(form.getByLabel("Starting balance")).toBeDisabled();
    await expect(form.getByLabel("Max loss ($)")).toBeDisabled();
    await expect(form.getByRole("button", { name: PRACTICE_COPY.threadSubmit })).toBeDisabled();
    await expect(form).toContainText(/One active thread at a time · close .+ thread in its journal to start another/);
    await expectCleanScreen(page);
    await form.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(/\/practice\/journal\?thread=\d+/);
  });

  // D-030, D-035: replacing the plan while a day is half practised leaves two open days. Ending the practised one must leave
  // the hub in agreement with the balance and the review: the new plan's Day 1 reads "list ready" (not "in progress"), the
  // thread's row is the day just ended (not a $0 for the unstarted one), and Continue and the review's Next day meet.
  test("after the practised day ends, the hub card and the thread row agree with the balance and the review", async ({ page, context }) => {
    test.setTimeout(180_000);
    const anyClose = {
      schemaVersion: 1,
      name: "Any close",
      watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
      liquidity: { minPrice: 1, minAvgVolume: 1 },
      when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
      maxResults: 50,
    };
    expect((await context.request.post(`${origin}/api/desk/screener/filters`, { data: { spec: anyClose } })).ok()).toBeTruthy();
    const threads = await startThread(page);
    const daily = page.locator("#daily-list");
    const savePlan = async () => {
      await daily.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: "Any close" }).check();
      await daily.locator('input[type="date"]').fill(DAY);
      await daily.getByRole("group", { name: "Days" }).getByRole("button", { name: "5", exact: true }).click();
      await daily.getByLabel("To", { exact: true }).fill("09:40");
      await daily.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: "1m", exact: true }).click();
      await daily.getByRole("button", { name: PRACTICE_COPY.planSubmit, exact: true }).click();
    };
    await savePlan();
    await expect(daily.getByRole("button", { name: PRACTICE_COPY.planStart })).toBeVisible({ timeout: 60_000 });
    await daily.getByRole("button", { name: PRACTICE_COPY.planStart }).click();
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    const practised = page.url();

    // Practise the name and take a trade; the day stays open.
    await page.getByRole("button", { name: "Practise TSLA" }).first().click();
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

    // Replace the plan while that day is half practised: its new Day 1 opens as a second, unstarted day.
    await openDesk(page, "/practice");
    await daily.getByRole("button", { name: PRACTICE_COPY.planNew }).click();
    await savePlan();
    await page.waitForURL((url) => /\/practice\/day\?id=\d+/.test(url.toString()) && url.toString() !== practised, { timeout: 60_000 });
    const fresh = page.url();

    // End the practised day from its own screen: the review offers the next day.
    await page.goto(practised);
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();

    const [only] = (await (await context.request.get(`${origin}/api/desk/replay/threads`)).json()) as Array<{ thread: { id: number } }>;
    const read = await readThread(context, only!.thread.id);
    const ended = read.daily.at(-1)!;
    const card = threads.getByRole("article", { name: "Active practice thread" });
    await openDesk(page, "/practice");
    await expect(card).toContainText(formatBalance(read.thread.stats.balance));
    await expect(card).toContainText("Last day");
    await expect(card).toContainText(`${formatDayResult(ended.pnl_usd)} realized · 1 practice trade`);
    await expect(card).not.toContainText("0 practice trades");
    await expect(daily).toContainText("Day 1 of 5 · list ready");
    await expect(daily).not.toContainText("in progress");

    // The hub's Continue and the review's Next day open the same day.
    await daily.getByRole("button", { name: PRACTICE_COPY.planContinue }).click();
    await page.waitForURL(fresh);
    await page.goto(practised);
    await page.getByRole("button", { name: PRACTICE_COPY.dayAfter }).click();
    await page.waitForURL(fresh);
  });

  // D-001: a filter that reads bars of the list day itself cannot be listed before its first bar has closed.
  test("the plan form moves the list time for a 15-minute filter, disables earlier times and says why", async ({ page }) => {
    await startThread(page);
    const daily = page.locator("#daily-list");
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
    // D-017: 10:00 satisfies the filter, so no line says otherwise; the reason sits on the disabled earlier time, and Start day is ready.
    await expect(daily.getByText(/needs a list time of/)).toHaveCount(0);
    await expect(daily.getByRole("alert")).toHaveCount(0);
    await expect(premarket).toHaveAttribute("title", "Abnormal volume needs a list time of 10:00 AM or later · before then none of its bars of the day has closed");
    await expect(daily.getByRole("button", { name: PRACTICE_COPY.planSubmit, exact: true })).toBeEnabled();
    await expect(daily.getByText("Arm up to 5 strategies · 2 armed")).toBeVisible();
    await expect(daily.getByLabel("From", { exact: true })).toHaveValue("10:00"); // the window starts at the list

    await filters.getByRole("checkbox", { name: "Abnormal volume" }).uncheck();
    await expect(premarket).toBeEnabled();
    await expect(daily.getByText("Arm up to 5 strategies · 1 armed")).toBeVisible(); // dropping a filter disarms it
    await tenOclock.click(); // Gap up needs 8:30: 10:00 holds, and nothing says it needs 8:30
    await expect(daily.getByText(/needs a list time of/)).toHaveCount(0);
    await expect(daily.getByRole("button", { name: PRACTICE_COPY.planSubmit, exact: true })).toBeEnabled();
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
    expect(second.status(), "one active day thread at a time").toBe(409);
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
