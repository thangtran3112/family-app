import type { Page } from "@playwright/test";
import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { formatBalance } from "../../lib/replay/threadView.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import {
  ANY_CLOSE,
  DAY,
  START_BUTTON,
  THREAD_URL,
  SCREEN_URL,
  clickNewPlan,
  createThreadByApi,
  discardNewPlan,
  expectNoDayLanguage,
  fillNewPlan,
  openNewPlan,
  openRow,
  railSection,
  saveFilter,
  startThread,
  threadIdOf,
} from "./hub-helpers";

// The Practice landing, its New thread modal and the thread's Summary (02r2, Paper mocks LEW-0 and X9Y-0; ADR-0025). A thread is a paper account
// with one clock: the modal asks when it starts (a date and a time, 9:30 AM ET by default), and the landing shows each thread as one card.

/** The delete confirm names its thread (D-079): "Delete Freestyle · Oct 15?". */
const deleteDialog = (page: Page) => page.getByRole("dialog", { name: /^Delete Freestyle · .+\?$/ });
const table = (page: Page) => page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel });
const rows = (page: Page) => table(page).getByRole("row", { name: /^Freestyle · / });
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("Practice landing", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("with no thread the page is the header, New thread and one sentence, with no session setup, notable days or day language", async ({ page }) => {
    await openDesk(page, "/practice");
    await expect(page.getByRole("heading", { name: "Practice", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true })).toBeVisible();
    await expect(page.getByTestId("day-slots")).toHaveText(practiceText("threadSlots", { active: 0, max: 10 }));
    await expect(page.getByText(PRACTICE_COPY.threadNone)).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    for (const gone of ["Start a practice session", "Notable days", "New plan", "Plan"]) {
      await expect(page.getByRole("heading", { name: gone })).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "New plan", exact: true })).toHaveCount(0);
    await expect(page.locator("#start-practice, #notable-days, #daily-list")).toHaveCount(0);
    await expect(page.locator("#main-content")).not.toContainText("risk plan"); // D-115
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // The one primary button opens the modal.
    await page.getByRole("button", { name: PRACTICE_COPY.landingStartFirst }).click();
    await expect(page.getByRole("dialog", { name: PRACTICE_COPY.newThreadTitle })).toBeVisible();
  });

  test("a thread is one card: its name, balance, open positions, the thread's time with the clock's state, and one way on", async ({ page, context }) => {
    const id = await createThreadByApi(context, { balance: 25_000 });
    await openDesk(page, "/practice");
    for (const name of [PRACTICE_COPY.landingColThread, PRACTICE_COPY.landingColBalance, PRACTICE_COPY.landingColPositions, PRACTICE_COPY.landingColClock, PRACTICE_COPY.landingColAction]) {
      await expect(table(page).getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    // No Progress, Days, Win rate or Last day: nothing counts days (ADR-0025).
    for (const gone of ["Progress", "Days", "Days passed", "Last day"]) await expect(table(page).getByRole("columnheader", { name: gone, exact: true })).toHaveCount(0);
    const row = rows(page).first();
    await expect(row.getByRole("link", { name: /^Freestyle · / })).toBeVisible();
    await expect(row).toContainText(/Started [A-Z][a-z]{2} \d{1,2}/); // the wall-clock day the thread was made (setup metadata, never a replayed day)
    await expect(row).toContainText(formatBalance(25_000));
    await expect(row).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(row).toContainText(PRACTICE_COPY.threadActive);
    await expect(row.getByTestId("thread-positions")).toHaveText(PRACTICE_COPY.threadPositionsNone);
    // The thread's time: the start instant, paused (nobody pressed Play), to the minute.
    await expect(row.getByTestId("thread-time")).toHaveText("Fri 2026-09-25 · 9:30 AM ET");
    await expect(row).toContainText(PRACTICE_COPY.clockStatePaused);
    // The one way on is the Screen; the name links to the Summary. No Resume, Start Trading or Start a new plan.
    await expect(row.getByRole("link", { name: PRACTICE_COPY.landingOpenScreen })).toHaveAttribute("href", `/practice/screen?thread=${id}`);
    for (const gone of [/^Resume$/, /^Start Trading$/, "Start a new plan"]) await expect(row.getByRole("link", { name: gone }).or(row.getByRole("button", { name: gone }))).toHaveCount(0);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    await openRow(page, row);
    await expect(page).toHaveURL(new RegExp(`/practice/thread\\?id=${id}$`));
    // The journal is one click from the thread page.
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(new RegExp(`/practice/journal\\?thread=${id}`));

    await openDesk(page, "/practice");
    await rows(page).first().getByRole("link", { name: PRACTICE_COPY.landingOpenScreen }).click();
    await page.waitForURL(SCREEN_URL);
  });

  test("while the threads load the table shows skeleton rows and New thread waits", async ({ page }) => {
    // Hold the threads answer back so the loading state stays on screen long enough to look at.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/desk/replay/threads", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/practice");
    const loading = page.getByRole("table", { name: PRACTICE_COPY.threadsLoading });
    await expect(loading).toHaveAttribute("aria-busy", "true");
    await expect(loading.locator("tbody tr")).toHaveCount(2);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true })).toBeDisabled();
    release();
    await expect(page.getByText(PRACTICE_COPY.threadNone)).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true })).toBeEnabled();
  });

  test("the New thread modal asks for the filters, the start and the chart, offers optional risk rules, has no Swing or block of days, and closes three ways", async ({ page, context }) => {
    for (const name of ["Any close", "Second close", "Third close", "Fourth close"]) await saveFilter(context, { ...ANY_CLOSE, name });
    let dialog = await openNewPlan(page);
    await expect(dialog.getByRole("heading", { name: PRACTICE_COPY.newThreadTitle })).toBeVisible();

    // Balance: a whole-dollar box that reads "50,000" once she leaves it, with SIMULATED beside its label (not inside the box).
    const balance = dialog.getByLabel(PRACTICE_COPY.threadStartingBalance);
    await expect(balance).toHaveValue("50,000");
    await expect(balance).toHaveAttribute("inputmode", "numeric");
    await balance.fill("75000");
    await balance.blur();
    await expect(balance).toHaveValue("75,000");
    await balance.fill("50000");
    await balance.blur();
    const badge = dialog.getByText(PRACTICE_COPY.threadSimulated, { exact: true }).first();
    await expect(badge).toBeVisible();
    expect(await badge.evaluate((node) => node.closest("input, [class*=moneyBox]") === null), "SIMULATED sits outside the money box").toBe(true);

    // Filters: one column. Every checkbox shares a left edge and sits below the one before.
    const filters = dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true });
    await expect(filters.getByText(practiceText("newThreadFiltersHint", { max: 3 }))).toBeVisible();
    await expect(filters.getByRole("checkbox").first()).toBeVisible(); // the list loads after the dialog opens
    const boxes = await filters.getByRole("checkbox").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((rect) => ({ x: Math.round(rect.x), y: rect.y })));
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    expect(new Set(boxes.map((box) => box.x)).size, "one left edge").toBe(1);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y);
    await expect(filters).toContainText("At each daily close during regular hours");
    // At most three filters: the fourth waits until one is unticked.
    for (const name of ["Any close", "Second close", "Third close"]) await filters.getByRole("checkbox", { name }).check();
    await expect(filters.getByRole("checkbox", { name: "Fourth close" })).toBeDisabled();
    await expect(filters).not.toContainText(/Preset|Yours/); // D-076, M-06

    // The start and the chart: a date, a time (9:30 AM ET by default), the Screen's size and the chart interval.
    await expect(dialog.getByTestId("first-day-note")).toBeVisible();
    await expect(dialog.getByLabel(PRACTICE_COPY.newThreadStartDay)).toBeVisible();
    await expect(dialog.getByLabel(PRACTICE_COPY.newThreadStartTime)).toHaveValue("09:30");
    await expect(dialog.getByLabel(PRACTICE_COPY.newThreadListSize)).toHaveValue("30");
    await expect(dialog.getByRole("radiogroup", { name: PRACTICE_COPY.planInterval })).toBeVisible();
    // Optional risk rules, counted for each ET date of the clock (D-076 kept the strategies and the stop note out).
    const risk = dialog.getByRole("group", { name: PRACTICE_COPY.newThreadRisk });
    await expect(risk.getByLabel(PRACTICE_COPY.threadMaxLoss)).toBeVisible();
    await expect(risk.getByLabel(PRACTICE_COPY.threadMaxTrades)).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Arm strategies" })).toHaveCount(0);
    // No Swing, no block of days, no list time, no window, no hidden dates: a thread starts at one instant and moves forward.
    await expect(dialog.getByRole("radio", { name: "Swing", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("radiogroup", { name: "Days" })).toHaveCount(0);
    for (const gone of ["List time", "Start at (ET)", "Sessions", "First day"]) await expect(dialog.getByLabel(gone, { exact: true })).toHaveCount(0);
    await expect(dialog).not.toContainText(/swing|list time|focus until|practice window|hidden day|show date|hide dates?|block of days/i);
    await expect(dialog.getByText(PRACTICE_COPY.newPlanFooter)).toBeVisible();
    await expect(dialog.getByRole("button", { name: START_BUTTON })).not.toHaveAttribute("aria-disabled", "true");
    await expectCleanScreen(page);

    // She has edited the form, so Escape asks first (M-05); Discard closes it.
    await discardNewPlan(page);
    // Closes with Escape, with Close, and with a click on the dimmed page (an untouched form closes at once).
    dialog = await clickNewPlan(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    dialog = await clickNewPlan(page);
    await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanClose, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await clickNewPlan(page);
    await page.mouse.click(4, 4);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true })).toBeFocused();
  });

  test("Start waits for a filter and says what is wrong in the field as she types", async ({ page, context }) => {
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    const submit = dialog.getByRole("button", { name: START_BUTTON });
    await expect(submit).toBeDisabled();
    const status = dialog.locator("footer").getByRole("status");
    await expect(status).toContainText(PRACTICE_COPY.newThreadFilterFirst);
    await fillNewPlan(dialog, { balance: "1000" });
    await expect(submit).not.toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel(PRACTICE_COPY.threadStartingBalance).fill("500");
    // The contract's rule, shown under its field and echoed by the button; nothing was created.
    await expect(dialog.getByRole("alert").filter({ hasText: /Starting balance/ })).toBeVisible();
    await expect(status).toContainText(/Starting balance/);
    await expect(submit).toBeDisabled();
    await submit.click({ force: true });
    await expect(dialog).toBeVisible();
    expect((await (await context.request.get("/api/desk/replay/threads")).json()) as unknown[]).toHaveLength(0);
  });

  test("a start after the last finished day says so as she edits, clears when she fixes it and never moves the form", async ({ page, context }) => {
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: "Any close" }).check();
    const date = dialog.locator('input[type="date"]');
    await expect(date).toHaveAttribute("max", "2026-10-15"); // the last finished day on the E2E clock
    await date.fill(DAY);
    const interval = dialog.getByRole("radiogroup", { name: PRACTICE_COPY.planInterval, exact: true });
    const before = (await interval.boundingBox())!.y;
    const start = dialog.getByRole("button", { name: START_BUTTON });
    await expect(start).not.toHaveAttribute("aria-disabled", "true");

    await date.fill("2026-10-16"); // the day after the last finished one: its data does not exist yet
    await expect(dialog.getByRole("alert").first()).toBeVisible();
    await expect(start).toHaveAttribute("aria-disabled", "true");
    expect((await interval.boundingBox())!.y, "the error line was reserved: nothing moved").toBeCloseTo(before, 0);

    await date.fill(DAY);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(start).not.toHaveAttribute("aria-disabled", "true");
    expect((await interval.boundingBox())!.y).toBeCloseTo(before, 0);
  });

  test("Start thread sends the thread with its v2 setup and lands on the Summary, where the clock waits at the start", async ({ page, context }) => {
    test.setTimeout(180_000);
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    for (const gone of [/arm .*strateg/i, /risk plan/i, /alert strateg/i]) await expect(dialog.getByText(gone)).toHaveCount(0);
    await fillNewPlan(dialog, { balance: "25000", interval: "5m" });
    const sent = page.waitForRequest((request) => request.url().endsWith("/replay/threads") && request.method() === "POST");
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    const body = (await sent).postDataJSON() as { startingBalance: number; setup: Record<string, unknown> & { setup: { armed: unknown; interval: string }; screen: { filters: unknown[] } } };
    expect(body.startingBalance).toBe(25_000);
    expect(body.setup.schemaVersion, "the v2 setup contract").toBe(2);
    expect(Date.parse(body.setup.startAt as string), "one instant, 9:30 AM ET on the day she picked").toBe(Date.parse(`${DAY}T09:30:00-04:00`));
    expect(body.setup.setup.armed, "nothing armed").toEqual([]);
    expect(body.setup.setup.interval).toBe("5m");
    expect(body.setup.screen.filters).toHaveLength(1);
    for (const gone of ["sessions", "firstDay", "plan_days", "listAt", "window", "hideDates"]) expect(JSON.stringify(body), `${gone} is retired`).not.toContain(gone);
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    const id = threadIdOf(page);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Freestyle · ");
    const place = page.getByRole("region", { name: "Thread balance" });
    await expect(place).toContainText(formatBalance(25_000));
    await expect(place).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(place).toContainText("At Fri 2026-09-25 · 9:30 AM ET");
    await expect(place).toContainText(PRACTICE_COPY.threadPositionsNone);
    // The clock: paused at the start, the full date and the time to the second, with Play, the speeds, Next open and Jump.
    await expect(page.getByTestId("thread-clock-time")).toHaveText("Fri 2026-09-25 · 9:30:00 AM ET");
    await expect(page.getByTestId("thread-clock-state")).toHaveText(PRACTICE_COPY.clockStatePaused);
    // The one next step is the Screen; the stats are their own card and count trades, not days.
    const step = page.getByRole("region", { name: PRACTICE_COPY.overviewStepTitle });
    await expect(step.getByRole("link", { name: PRACTICE_COPY.overviewOpenScreen })).toHaveAttribute("href", `/practice/screen?thread=${id}`);
    const stats = page.getByRole("region", { name: "Thread stats" });
    for (const label of [PRACTICE_COPY.overviewStatClosed, PRACTICE_COPY.threadWinRate, PRACTICE_COPY.overviewStatWins, PRACTICE_COPY.overviewStatLosses, PRACTICE_COPY.overviewStatOpen]) {
      await expect(stats.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${id}`);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.overviewResultsTitle })).toContainText(PRACTICE_COPY.overviewResultsNone);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    await step.getByRole("link", { name: PRACTICE_COPY.overviewOpenScreen }).click();
    await page.waitForURL(SCREEN_URL);
    // The Screen wears the thread's tab strip: Summary is the way back to the thread's page, the back link goes to the thread list.
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToPractice })).toHaveAttribute("href", "/practice");
    await page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel }).getByRole("tab", { name: PRACTICE_COPY.tabSummary }).click();
    await page.waitForURL(`**/practice/thread?id=${id}`);
  });

  test("with a thread active the modal still opens, and the Summary has Delete thread and nothing that edits the setup; deleting returns to Practice", async ({ page, context }) => {
    test.setTimeout(180_000);
    await saveFilter(context);
    const id = await createThreadByApi(context);
    await openDesk(page, "/practice");
    const dialog = await clickNewPlan(page);
    await expect(dialog.getByText("is already active")).toHaveCount(0); // any number of threads may run, up to the slots
    await page.keyboard.press("Escape");

    // A setup is never replaced or edited (a new setup is a new thread): the Summary has Delete thread and nothing that changes the setup.
    await openDesk(page, `/practice/thread?id=${id}`);
    const step = page.getByRole("region", { name: PRACTICE_COPY.overviewStepTitle });
    await expect(step.getByRole("button", { name: /^Replace/ })).toHaveCount(0);
    await step.getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm, exact: true }).click();
    const confirm = deleteDialog(page);
    await expect(confirm).toContainText(PRACTICE_COPY.threadDeleteBodyFreestyle);
    await confirm.getByRole("button", { name: PRACTICE_COPY.threadDeleteKeep }).click();
    await expect(confirm).toHaveCount(0);
    await expect(step.getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm, exact: true })).toBeVisible(); // Keep leaves the thread alone
    await step.getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm, exact: true }).click();
    await deleteDialog(page).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await page.waitForURL("**/practice");
    expect((await context.request.get(`${origin}/api/desk/replay/threads/${id}`)).status()).toBe(404);
  });

  test("several threads list as several rows, and Delete removes one after a confirm", async ({ page, context }) => {
    const first = await createThreadByApi(context, { balance: 20_000 });
    const second = await createThreadByApi(context, { balance: 30_000 });
    const closed = await createThreadByApi(context, { balance: 40_000 });
    expect((await context.request.post(`${origin}/api/desk/replay/threads/${closed}/close`)).ok()).toBeTruthy();
    await openDesk(page, "/practice");
    await expect(rows(page)).toHaveCount(3); // two active and one closed, active first
    await expect(rows(page).first()).toContainText(formatBalance(30_000)); // newest active first
    await expect(page.getByTestId("day-slots")).toHaveText(practiceText("threadSlots", { active: 2, max: 10 }));
    await expect(page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true })).toBeEnabled();
    await expect(table(page).getByRole("link", { name: PRACTICE_COPY.landingOpenScreen })).toHaveCount(2); // each active thread opens its own Screen
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);

    // The two threads of one day read apart by their stored names (D-069): the second carries a (2).
    const names = await table(page).getByRole("link", { name: /^Freestyle · / }).allTextContents();
    expect(new Set(names).size, "no two threads read alike").toBe(3);

    // Delete asks first; Keep leaves the thread alone, a click on the dialog never opens the thread page.
    const row = rows(page).filter({ hasText: formatBalance(20_000) });
    await row.getByRole("button", { name: /^Delete/ }).click();
    const confirm = deleteDialog(page);
    await expect(confirm).toContainText(PRACTICE_COPY.threadDeleteBodyFreestyle);
    const warning = await confirm.locator("p").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
    expect(warning, "no line of the dialog is cut off").toEqual([]);
    await confirm.click({ position: { x: 4, y: 4 } });
    await expect(page).toHaveURL(/\/practice$/);
    await confirm.getByRole("button", { name: PRACTICE_COPY.threadDeleteKeep }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(3);

    const target = (await row.getByRole("link").first().textContent())!;
    await row.getByRole("button", { name: /^Delete/ }).click();
    await expect(deleteDialog(page)).toContainText(literal(target).replace(/\\/g, ""));
    await deleteDialog(page).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /^Deleted Freestyle · .+$/ })).toHaveText(practiceText("threadDeleted", { name: target }));
    await expect(rows(page)).toHaveCount(2);
    await expect(table(page)).not.toContainText(formatBalance(20_000));
    expect((await context.request.get(`${origin}/api/desk/replay/threads/${first}`)).status()).toBe(404);
    expect((await context.request.get(`${origin}/api/desk/replay/threads/${second}`)).ok()).toBeTruthy();

    // A closed thread deletes too, and the last row going leaves the empty sentence.
    await rows(page).filter({ hasText: PRACTICE_COPY.threadClosedBadge }).getByRole("button", { name: /^Delete/ }).click();
    await deleteDialog(page).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(rows(page)).toHaveCount(1);
    await table(page).getByRole("button", { name: /^Delete/ }).click();
    await deleteDialog(page).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(page.getByText(PRACTICE_COPY.threadNone)).toBeVisible();
  });

  test("a thread that is not chosen and one that is not found say different things on every route, and a picker's hint names where its rows go (D-164, D-191, D-193)", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    // Not found: an id the server does not know, and an id that is no number (she gave one; it cannot name a thread).
    for (const [path, param] of [["/practice/thread", "id"], ["/practice/screen", "thread"], ["/practice/journal", "thread"]] as const) {
      for (const bad of ["999999", "abc", "0"]) {
        await openDesk(page, `${path}?${param}=${bad}`);
        await expect(page.getByText(PRACTICE_COPY.threadPageNotFound), `${path} ${bad}`).toBeVisible();
        await expect(page.getByText(PRACTICE_COPY.threadPickTitle), `${path} ${bad} is not "not selected"`).toHaveCount(0);
      }
    }
    for (const path of ["/practice/replay?id=abc", "/practice/journal?id=abc"]) {
      await openDesk(page, path);
      await expect(page.getByText(PRACTICE_COPY.sessionNotFound), path).toBeVisible();
    }
    // Not chosen: the picker, one hint per route that says what a row opens, every row going there.
    for (const [path, hint, rowHref] of [
      ["/practice/thread", PRACTICE_COPY.threadPickHintThread, `/practice/thread?id=${id}`],
      ["/practice/screen", PRACTICE_COPY.screenPickHint, `/practice/screen?thread=${id}`],
      ["/practice/replay", PRACTICE_COPY.threadPickHintReplay, `/practice/thread?id=${id}`],
    ] as const) {
      await openDesk(page, path);
      await expect(page.getByText(PRACTICE_COPY.threadPickTitle), path).toBeVisible();
      await expect(page.getByText(hint, { exact: true }), path).toBeVisible();
      await expect(page.getByLabel("Your threads").getByRole("link").first(), path).toHaveAttribute("href", rowHref);
      await expectCleanScreen(page);
    }
    // The routes of the retired day model are not served: there is no day, no day list and no week to open.
    for (const gone of ["/practice/day?id=1", "/practice/week?thread=1", "/practice/order?thread=1"]) {
      const response = await page.goto(gone);
      expect(response?.status(), `${gone} is retired`).toBe(404);
    }
  });

  test("the table has a fixed layout, Balance is right-aligned on one line, and its text lines up with the page title and New thread (D-110, D-111, D-113, D-114)", async ({ page, context }) => {
    await createThreadByApi(context, { balance: 20_000 });
    await createThreadByApi(context, { balance: 30_000 });
    await openDesk(page, "/practice");
    await expect(table(page)).toHaveCSS("table-layout", "fixed");
    await expect(table(page).getByRole("columnheader", { name: PRACTICE_COPY.landingColBalance })).toHaveCSS("text-align", "right");
    const row = rows(page).first();
    // The amount and its SIMULATED pill share one line (the column used to be narrower than the pair).
    const [amount, pill] = [await row.getByText("$30,000.00").boundingBox(), await row.getByText(PRACTICE_COPY.threadSimulated, { exact: true }).first().boundingBox()];
    expect(Math.abs(amount!.y + amount!.height / 2 - (pill!.y + pill!.height / 2)), "amount and pill on one line").toBeLessThan(8);
    // D-111: the title and the first cell's text start at one x; the action ends where New thread ends.
    const title = (await page.getByRole("heading", { name: "Practice", level: 1 }).boundingBox())!;
    const name = (await row.getByRole("link").first().boundingBox())!;
    expect(Math.abs(name.x - title.x), "one shared inset on the left").toBeLessThanOrEqual(1);
    const newThread = (await page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true }).boundingBox())!;
    const del = (await row.getByRole("button", { name: /^Delete/ }).boundingBox())!;
    expect(Math.abs(newThread.x + newThread.width - (del.x + del.width)), "and on the right").toBeLessThanOrEqual(1);
    // D-114: a column stays where it is when the rows change.
    const before = (await table(page).getByRole("columnheader", { name: PRACTICE_COPY.landingColBalance }).boundingBox())!.x;
    await row.getByRole("button", { name: /^Delete/ }).click();
    await deleteDialog(page).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(rows(page)).toHaveCount(1);
    expect((await table(page).getByRole("columnheader", { name: PRACTICE_COPY.landingColBalance }).boundingBox())!.x).toBe(before);
  });
});

// D-133: the journal's Edit plan form is on the same field kit as the New thread modal: one control height, one radius, sentence-case labels.
test.describe("Edit plan form", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("its segmented controls, inputs and buttons share one height and radius, and no label is upper-cased", async ({ page, context }) => {
    const id = await createThreadByApi(context, { maxLoss: 600 });
    await openDesk(page, `/practice/journal?thread=${id}`);
    const plan = await railSection(page, "Thread details", PRACTICE_COPY.threadPlanTitle); // a tab and drawer at 1180
    await plan.getByRole("button", { name: PRACTICE_COPY.threadEditPlan }).click();
    const form = plan.getByRole("form", { name: PRACTICE_COPY.threadEditPlan });
    await expect(form.getByLabel("Max loss ($)")).toBeVisible();
    const look = await form.evaluate((node) => {
      const measure = (selector: string) => [...node.querySelectorAll(selector)].map((el) => `${Math.round(el.getBoundingClientRect().height)}px ${getComputedStyle(el).borderRadius}`);
      return {
        controls: [...new Set([...measure('[role="radiogroup"]'), ...measure("input"), ...measure("button:not([role=radio])")])],
        caps: [...node.querySelectorAll("label, legend")].filter((el) => getComputedStyle(el).textTransform !== "none").map((el) => el.textContent),
      };
    });
    expect(look.controls, "one height and one radius for every control").toHaveLength(1);
    expect(look.caps, "no label is upper-cased").toEqual([]);
  });
});

// startThread (the modal, end to end) is the helper the other specs build on; this one test keeps it honest.
test.describe("startThread helper", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("starts a thread through the modal with its risk rules and lands on a Summary that shows its clock", async ({ page, context }) => {
    test.setTimeout(180_000);
    const id = await startThread(page, context, { balance: "30000", maxLoss: "600", maxTrades: "3", note: "Trade only clean pullbacks." });
    const thread = await (await context.request.get(`${origin}/api/desk/replay/threads/${id}`)).json();
    expect(thread.thread.startingBalance).toBe(30_000);
    expect(thread.thread.plan).toMatchObject({ maxLossUsd: 600, maxTrades: 3, planNote: "Trade only clean pullbacks." });
    expect(thread.clock.running).toBe(false);
    await expect(page.getByTestId("thread-clock-time")).toHaveText("Fri 2026-09-25 · 9:30:00 AM ET");
  });
});
