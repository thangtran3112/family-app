import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { formatBalance } from "../../lib/replay/threadView.ts";
import { universeNeedLine } from "../../lib/replay/universeView.ts";
import { origin } from "../helpers";
import type { Locator } from "@playwright/test";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { ANY_CLOSE, DAY_URL, START_BUTTON, THREAD_URL, clickNewPlan, createThreadByApi, discardNewPlan, fillNewPlan, openFirstDay, openNewPlan, openRow, saveFilter, startThread, threadIdOf } from "./hub-helpers";

// The Practice landing, its New plan modal and the thread page (02r2, Paper mocks LEW-0 and X9Y-0).

test.describe("Practice landing", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the landing is the header, New plan and the thread table, with no session setup, notable days or rail", async ({ page, context }) => {
    await openDesk(page, "/practice");
    await expect(page.getByRole("heading", { name: "Practice", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true })).toBeVisible();
    // No thread yet: the same empty sentence the old band used, and the table waits for a first row.
    await expect(page.getByText(PRACTICE_COPY.threadNone)).toBeVisible();
    await expect(page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel })).toHaveCount(0);
    for (const gone of ["Start a practice session", "Notable days", PRACTICE_COPY.planTitle, PRACTICE_COPY.threadsTitle]) {
      await expect(page.getByRole("heading", { name: gone })).toHaveCount(0);
    }
    await expect(page.locator("#start-practice, #notable-days, #daily-list")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Practice sessions" })).toHaveCount(0);
    await expectCleanScreen(page);

    // A thread made elsewhere shows as a row with the table's columns, SIMULATED beside its balance.
    const id = await createThreadByApi(context, { balance: 25_000 });
    await openDesk(page, "/practice");
    const table = page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel });
    for (const name of [PRACTICE_COPY.landingColThread, PRACTICE_COPY.threadBalance, PRACTICE_COPY.landingColProgress, PRACTICE_COPY.threadWinRate, PRACTICE_COPY.landingColAction]) {
      await expect(table.getByRole("columnheader", { name })).toBeVisible();
    }
    // 5R: one Progress column replaces Days and Skipped (4 practiced beside Day 6 of 20 read as a contradiction).
    for (const gone of ["Days", PRACTICE_COPY.threadSkipped]) await expect(table.getByRole("columnheader", { name: gone, exact: true })).toHaveCount(0);
    const row = table.getByRole("row", { name: /Day trading/ });
    await expect(row).toContainText(PRACTICE_COPY.landingProgressNone);
    await expect(row).toContainText(PRACTICE_COPY.landingProgressNoDays);
    await expect(row).toContainText(/Started [A-Z][a-z]{2} \d{1,2}/); // the start date under the name (setup metadata, never a replayed day)
    await expect(row).toContainText(formatBalance(25_000));
    await expect(row).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(row).toContainText(PRACTICE_COPY.threadActive);
    // No plan yet: the row says a new plan is needed, and the button opens the modal for this thread.
    await row.getByRole("button", { name: PRACTICE_COPY.landingNeedsPlan }).click();
    await expect(page.getByRole("dialog", { name: /^New plan for/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // One action per row: no Overview or Journal link beside it, only the thread's name, which links to its page like the row does.
    await expect(row.getByRole("link")).toHaveCount(1);
    await expect(row.getByRole("link", { name: "Overview" })).toHaveCount(0);
    await expect(row.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveCount(0);
    await openRow(page, row);
    await expect(page).toHaveURL(new RegExp(`/practice/thread\\?id=${id}$`));
    // The journal is one click from the thread page.
    await page.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(new RegExp(`/practice/journal\\?thread=${id}`));
  });

  test("while the threads load the table shows skeleton rows and New plan waits", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true })).toBeDisabled();
    release();
    await expect(page.getByText(PRACTICE_COPY.threadNone)).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true })).toBeEnabled();
  });

  test("the New plan modal lists filters in one vertical column, asks for no risk plan, and closes three ways", async ({ page, context }) => {
    for (const name of ["Any close", "Second close", "Third close", "Fourth close"]) await saveFilter(context, { ...ANY_CLOSE, name });
    let dialog = await openNewPlan(page);
    await expect(dialog.getByRole("heading", { name: PRACTICE_COPY.newPlanTitle })).toBeVisible();

    // Balance and mode: a whole-dollar box that reads "50,000" once she leaves it, with SIMULATED beside its label (not inside the box), and the two modes.
    const balance = dialog.getByLabel("Starting balance");
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
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toBeEnabled();

    // Filters: one column. Every checkbox shares a left edge and sits below the one before.
    const filters = dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true });
    await expect(filters.getByText(practiceText("newPlanFiltersHint", { max: 3 }))).toBeVisible();
    await expect(filters.getByRole("checkbox").first()).toBeVisible(); // the list loads after the dialog opens
    const boxes = await filters.getByRole("checkbox").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((rect) => ({ x: Math.round(rect.x), y: rect.y })));
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    expect(new Set(boxes.map((box) => box.x)).size, "one left edge").toBe(1);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y);
    await expect(filters).toContainText("At each daily close during regular hours");

    // At most three filters: the fourth waits until one is unticked.
    for (const name of ["Any close", "Second close", "Third close"]) await filters.getByRole("checkbox", { name }).check();
    await expect(filters.getByRole("checkbox", { name: "Fourth close" })).toBeDisabled();

    // No "Preset" pills: a filter row is its checkbox, its name and its rule (D-076, M-06).
    await expect(filters).not.toContainText(/Preset|Yours/);

    // The rest of the form is on screen: dates (with the recorded-day note), days, names, hide dates, list time and size, interval, window.
    await expect(dialog.getByTestId("first-day-note")).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Days" }).getByRole("button")).toHaveText(["5", "10", "20", "30"]);
    await expect(dialog.getByRole("group", { name: PRACTICE_COPY.planMaxSymbols }).getByRole("button")).toHaveText(["1", "2", "3", "4", "5"]);
    await expect(dialog.getByRole("group", { name: PRACTICE_COPY.planHideDates }).getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("group", { name: PRACTICE_COPY.planListAt }).getByRole("button")).toHaveCount(3);
    await expect(dialog.getByLabel(PRACTICE_COPY.planListSize)).toHaveValue("30");
    await expect(dialog.getByRole("group", { name: PRACTICE_COPY.planInterval })).toBeVisible();
    for (const label of [PRACTICE_COPY.planWindowFrom, PRACTICE_COPY.planWindowTo]) await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
    // D-076: no Arm strategies, no Risk plan.
    await expect(dialog.getByRole("group", { name: "Arm strategies" })).toHaveCount(0);
    await expect(dialog.getByLabel("Max loss ($)")).toHaveCount(0);
    await expect(dialog.getByLabel(/^Plan note/)).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true })).toBeFocused();
  });

  test("Start waits for a filter and says what is wrong in the field as she types", async ({ page, context }) => {
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    const submit = dialog.getByRole("button", { name: START_BUTTON });
    await expect(submit).toBeDisabled();
    const status = dialog.locator("footer").getByRole("status");
    await expect(status).toContainText(PRACTICE_COPY.planSaveFilterFirst);
    await fillNewPlan(dialog, { balance: "1000" });
    await expect(submit).not.toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("Starting balance").fill("500");
    // The contract's rule, shown under its field and echoed by the button; nothing was created.
    await expect(dialog.getByRole("alert").filter({ hasText: "Starting balance: whole dollars" })).toBeVisible();
    await expect(status).toContainText("Starting balance: whole dollars");
    await expect(submit).toBeDisabled();
    await submit.click({ force: true });
    await expect(dialog).toBeVisible();
    expect((await (await context.request.get("/api/desk/replay/threads")).json()) as unknown[]).toHaveLength(0);
  });

  test("Start practice starts the thread and its plan, lands on the thread page, and Start day opens the day", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context, { balance: "25000", maxLoss: "600", maxTrades: "3", note: "Trade only clean pullbacks.", stop: true });
    const id = threadIdOf(page);
    await expect(page).toHaveURL(THREAD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("thread");
    const balance = page.getByRole("region", { name: "Thread balance" });
    await expect(balance).toContainText(formatBalance(25_000));
    await expect(balance).toContainText(PRACTICE_COPY.threadSimulated);
    // The stats are their own card now (5R); adherence says which day it is and what it measures.
    const stats = page.getByRole("region", { name: "Thread stats" });
    for (const label of [PRACTICE_COPY.threadDaysPracticed, PRACTICE_COPY.threadSkipped, PRACTICE_COPY.threadWinRate, PRACTICE_COPY.threadAdherence]) {
      await expect(stats.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(stats).toContainText(PRACTICE_COPY.threadAdherenceNone);
    await expect(stats).toContainText(PRACTICE_COPY.threadAdherenceMeaning);
    // The daily plan of this thread, with its armed filter; the dates stay hidden.
    const plan = page.getByRole("region", { name: "Daily list plan" });
    await expect(plan).toContainText("Day 1 of 5", { timeout: 60_000 }); // the data is prepared in the background first
    await expect(plan).toContainText("Any close");
    await expect(page.locator("body")).not.toContainText("2026-09-25");
    await expect(page.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${id}`);
    await expectCleanScreen(page);

    await openFirstDay(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5");
    // The day screen has a way back to the thread's page.
    await expect(page.getByRole("link", { name: PRACTICE_COPY.backToPractice })).toHaveAttribute("href", `/practice/thread?id=${id}`);

    // Back on the landing: the thread has a row whose Resume is today's open day.
    await openDesk(page, "/practice");
    const row = page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel }).getByRole("row", { name: /Day trading/ });
    await expect(row).toContainText(formatBalance(25_000));
    await row.getByRole("link", { name: PRACTICE_COPY.planResume, exact: true }).click();
    await page.waitForURL(DAY_URL);

    // The thread page is where she returns between days: today's day is a Resume link.
    await openDesk(page, `/practice/thread?id=${id}`);
    await expect(page.getByRole("region", { name: "Practice day" }).getByRole("link", { name: PRACTICE_COPY.planResume, exact: true })).toBeVisible();
  });

  test("with a day thread active the modal still offers Day and the thread page replaces its plan", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    const id = threadIdOf(page);
    await openDesk(page, "/practice");
    const dialog = await clickNewPlan(page);
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toBeEnabled();
    await expect(dialog.getByText("is already active")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Replace plan from the thread page: only the plan, the balance and risk plan stay with the thread.
    await openDesk(page, `/practice/thread?id=${id}`);
    await page.getByRole("button", { name: PRACTICE_COPY.threadPageReplace }).click();
    const replace = page.getByRole("dialog", { name: /^New plan for/ });
    await expect(replace).toBeVisible();
    await expect(replace.getByLabel("Starting balance")).toHaveCount(0);
    await expect(replace.getByLabel("Max loss ($)")).toHaveCount(0);
    await fillNewPlan(replace, { replace: true, days: "10" });
    await replace.getByRole("button", { name: START_BUTTON }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 90_000 });
    await expect(page.getByRole("region", { name: "Daily list plan" })).toContainText("Day 1 of 10", { timeout: 60_000 }); // the data is prepared in the background first
  });

  test("several day threads list as several rows, and Delete removes one after a confirm", async ({ page, context }) => {
    const first = await createThreadByApi(context, { balance: 20_000 });
    const second = await createThreadByApi(context, { balance: 30_000 });
    const closed = await createThreadByApi(context, { balance: 40_000 });
    expect((await context.request.post(`${origin}/api/desk/replay/threads/${closed}/close`)).ok()).toBeTruthy();
    await openDesk(page, "/practice");
    const table = page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel });
    await expect(table.getByRole("row", { name: /Day trading/ })).toHaveCount(3); // two active and one closed, active first
    await expect(table.getByRole("row", { name: /Day trading/ }).first()).toContainText(formatBalance(30_000)); // newest active first
    await expect(page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true })).toBeEnabled();
    await expect(table.getByRole("button", { name: PRACTICE_COPY.landingNeedsPlan })).toHaveCount(2); // each active day thread reads its own plan
    await expectCleanScreen(page);

    // Delete asks first; Keep leaves the thread alone, a click on the dialog never opens the thread page.
    const row = table.getByRole("row", { name: /Day trading/ }).filter({ hasText: formatBalance(20_000) });
    await row.getByRole("button", { name: /^Delete/ }).click();
    const confirm = page.getByRole("dialog", { name: PRACTICE_COPY.threadDeleteTitle });
    await expect(confirm).toContainText(PRACTICE_COPY.threadDeleteBody);
    await confirm.click({ position: { x: 4, y: 4 } });
    await expect(page).toHaveURL(/\/practice$/);
    await confirm.getByRole("button", { name: PRACTICE_COPY.threadDeleteKeep }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(table.getByRole("row", { name: /Day trading/ })).toHaveCount(3);

    await row.getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("dialog", { name: PRACTICE_COPY.threadDeleteTitle }).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(table.getByRole("row", { name: /Day trading/ })).toHaveCount(2);
    await expect(table).not.toContainText(formatBalance(20_000));
    expect((await context.request.get(`${origin}/api/desk/replay/threads/${first}`)).status()).toBe(404);
    expect((await context.request.get(`${origin}/api/desk/replay/threads/${second}`)).ok()).toBeTruthy();

    // A closed thread deletes too, and the last row going leaves the empty sentence.
    await table.getByRole("row", { name: /Day trading/ }).filter({ hasText: PRACTICE_COPY.threadClosedBadge }).getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("dialog", { name: PRACTICE_COPY.threadDeleteTitle }).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(table.getByRole("row", { name: /Day trading/ })).toHaveCount(1);
    await table.getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("dialog", { name: PRACTICE_COPY.threadDeleteTitle }).getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm }).click();
    await expect(page.getByText(PRACTICE_COPY.threadNone)).toBeVisible();
  });

  test("the thread page says so for a thread that does not exist", async ({ page }) => {
    await openDesk(page, "/practice/thread?id=999999");
    await expect(page.getByText(PRACTICE_COPY.threadPageNotFound)).toBeVisible();
    await openDesk(page, "/practice/thread");
    await expect(page.getByText(PRACTICE_COPY.threadPageNotFound)).toBeVisible();
  });
});

// Fix wave 5S, stream 2: the New plan modal redesign (D-075 one grid, D-076 a modal around three things). Rows M-01 to M-05.
test.describe("New plan modal redesign", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  /** The segmented groups of the dialog (a group whose children are buttons), with how far their content pokes out and the tallest button. */
  const segmentedGroups = (dialog: Locator) =>
    dialog.locator('[role="group"]:has(> button[aria-pressed])').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
        return {
          name: node.getAttribute("aria-label") ?? document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent ?? "?",
          overflow: node.scrollWidth - node.clientWidth,
          poke: Math.max(0, ...buttons.map((rect) => rect.right - box.right), ...buttons.map((rect) => box.left - rect.left)),
          tallest: Math.max(...buttons.map((rect) => rect.height)),
        };
      }),
    );

  // M-01 (D-075): one two-column grid, shared label baselines, aligned control widths.
  test("every segmented group holds its buttons, the labels share a baseline per row and the text controls share a width", async ({ page, context }) => {
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: "Any close" }).check();
    const groups = await segmentedGroups(dialog);
    expect(groups.length).toBeGreaterThanOrEqual(6); // mode, days, names, hide dates, list time, interval
    for (const group of groups) {
      expect(group.overflow, `${group.name}: scrollWidth <= clientWidth`).toBeLessThanOrEqual(0);
      expect(group.poke, `${group.name}: no button outside its box`).toBeLessThanOrEqual(0.5);
      expect(group.tallest, `${group.name}: one line of height`).toBeLessThanOrEqual(34);
    }
    const label = async (text: string) => (await dialog.getByText(text, { exact: true }).first().boundingBox())!;
    expect((await label("First day")).y, "First day and Days share a baseline").toBeCloseTo((await label("Days")).y, 0);
    expect((await label("Names a day")).y, "Names a day and Hide dates share a baseline").toBeCloseTo((await label("Hide dates")).y, 0);
    expect((await label("List size")).y, "List size and Chart interval share a baseline").toBeCloseTo((await label("Chart interval")).y, 0);
    const firstDay = (await dialog.locator('input[type="date"]').boundingBox())!;
    const listSize = (await dialog.getByLabel(PRACTICE_COPY.planListSize).boundingBox())!;
    expect(firstDay.width, "the date and the list size are one column wide").toBeCloseTo(listSize.width, 0);
    expect(firstDay.x).toBeCloseTo(listSize.x, 0);
  });

  // M-02: the disabled list time explains itself in view, the footer is a live region, a blocked button still takes focus.
  test("a held list time says why in view, and the blocked Start button is focusable with its reason in a status line", async ({ page }) => {
    const dialog = await openNewPlan(page);
    const filters = dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true });
    const premarket = dialog.getByRole("group", { name: PRACTICE_COPY.planListAt, exact: true }).getByRole("button", { name: /^8:30/ });
    await filters.getByRole("checkbox", { name: "Abnormal volume" }).check();
    await expect(premarket).toHaveAttribute("aria-disabled", "true");
    await expect(premarket).not.toHaveAttribute("disabled", /.*/);
    await expect(dialog.getByText("Abnormal volume needs a list time of 10:00 AM or later", { exact: false })).toBeVisible();

    await filters.getByRole("checkbox", { name: "Abnormal volume" }).uncheck();
    const status = dialog.locator("footer").getByRole("status");
    await expect(status).toContainText(PRACTICE_COPY.planSaveFilterFirst);
    const start = dialog.getByRole("button", { name: START_BUTTON });
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await start.focus();
    await expect(start).toBeFocused();

    await dialog.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true }).click();
    await expect(dialog.locator("footer").getByRole("status")).toContainText(PRACTICE_COPY.swingBuildFirst);
    await expect(dialog.getByRole("button", { name: START_BUTTON })).toHaveAttribute("aria-disabled", "true");
  });

  // M-03: validation runs as she edits, the date has a max, the error has its own line and echoes by the button.
  test("a run of days that goes past the last finished day says so as she edits, clears when she fixes it and never moves the form", async ({ page, context }) => {
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: "Any close" }).check();
    const date = dialog.locator('input[type="date"]');
    await expect(date).toHaveAttribute("max", "2026-10-15"); // the last finished day on the E2E clock
    await date.fill("2026-10-05");
    const listTime = dialog.getByRole("group", { name: PRACTICE_COPY.planListAt, exact: true });
    const before = (await listTime.boundingBox())!.y;
    const start = dialog.getByRole("button", { name: START_BUTTON });
    await dialog.getByRole("group", { name: "Days" }).getByRole("button", { name: "5", exact: true }).click();
    await expect(start).toHaveAccessibleName("Start 5-day practice");

    await dialog.getByRole("group", { name: "Days" }).getByRole("button", { name: "30", exact: true }).click();
    await expect(start).toHaveAccessibleName("Start 30-day practice");
    const message = /30 sessions from .* run past the last finished day/;
    await expect(dialog.getByRole("alert").filter({ hasText: message })).toBeVisible();
    await expect(dialog.locator("footer").getByRole("status")).toContainText(message); // echoed by the button
    await expect(start).toHaveAttribute("aria-disabled", "true");
    expect((await listTime.boundingBox())!.y, "the error line was reserved: nothing moved").toBeCloseTo(before, 0);

    await dialog.getByRole("group", { name: "Days" }).getByRole("button", { name: "5", exact: true }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
    await expect(start).not.toHaveAttribute("aria-disabled", "true");
    expect((await listTime.boundingBox())!.y).toBeCloseTo(before, 0);
  });

  // M-04: the swing universe says its minimum in its header, a name left out can be removed, and the default first day is a recorded one.
  test("the swing universe states its minimum, lets a left-out name go, and starts on the first recorded morning", async ({ page, context }) => {
    expect((await context.request.post(`${origin}/api/desk/__e2e/universe-days`, { data: { days: [{ day: "2026-09-18", symbols: ["TSLA"] }] } })).ok()).toBeTruthy();
    await page.route("**/replay/threads/swing-universe", async (route) => {
      const answer = await route.fetch();
      const body = (await answer.json()) as { excluded: Array<{ symbol: string; reason: string }> };
      body.excluded = [{ symbol: "NEWCO", reason: "Not enough price history for this whole range" }];
      await route.fulfill({ response: answer, json: body });
    });
    const dialog = await openNewPlan(page);
    await dialog.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true }).click();
    await expect(dialog.getByLabel("First day")).toHaveValue("2026-09-18"); // inside the recorded window, not the guess three months back
    const universe = dialog.getByRole("group", { name: PRACTICE_COPY.swingUniverseSection, exact: true });
    await expect(universe).toContainText(universeNeedLine(0));
    const asked = page.waitForRequest((request) => request.url().includes("/swing-universe") && (request.postDataJSON() as { remove: string[] }).remove.includes("NEWCO"));
    await expect(universe.getByText("NEWCO")).toBeVisible({ timeout: 30_000 });
    await universe.getByRole("button", { name: "Remove NEWCO" }).click();
    await asked; // the name leaves the list she sends
    await expect(universe.getByText("NEWCO")).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" }); // let the last preview answer finish before the test ends
  });

  // M-05: Escape on a form she has edited asks before it throws the form away.
  test("Escape on an edited swing form asks first, Keep editing keeps it, Discard closes it", async ({ page }) => {
    const dialog = await openNewPlan(page);
    await dialog.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true }).click();
    await dialog.getByLabel("Sessions").fill("17");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(PRACTICE_COPY.newPlanDiscardTitle)).toBeVisible();
    await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanDiscardKeep }).click();
    await expect(dialog.getByLabel("Sessions")).toHaveValue("17");
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanDiscard, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A form she has not touched still closes at once.
    await clickNewPlan(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
