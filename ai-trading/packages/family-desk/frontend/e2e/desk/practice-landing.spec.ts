import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { formatBalance } from "../../lib/replay/threadView.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { ANY_CLOSE, DAY_URL, THREAD_URL, clickNewPlan, createThreadByApi, fillNewPlan, openFirstDay, openNewPlan, saveFilter, startThread, threadIdOf } from "./hub-helpers";

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
    for (const name of [PRACTICE_COPY.landingColThread, PRACTICE_COPY.threadBalance, PRACTICE_COPY.landingColDays, PRACTICE_COPY.threadSkipped, PRACTICE_COPY.threadWinRate, PRACTICE_COPY.landingColAction]) {
      await expect(table.getByRole("columnheader", { name })).toBeVisible();
    }
    const row = table.getByRole("row", { name: /Day trading/ });
    await expect(row).toContainText(formatBalance(25_000));
    await expect(row).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(row).toContainText(PRACTICE_COPY.threadActive);
    // No plan yet: the row says a new plan is needed, and the button opens the modal for this thread.
    await row.getByRole("button", { name: PRACTICE_COPY.landingNeedsPlan }).click();
    await expect(page.getByRole("dialog", { name: /^New plan for/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await row.getByRole("link", { name: PRACTICE_COPY.threadJournal }).click();
    await page.waitForURL(new RegExp(`/practice/journal\\?thread=${id}`));
  });

  test("the New plan modal lists filters in one vertical column, keeps the risk plan open, and closes three ways", async ({ page, context }) => {
    for (const name of ["Any close", "Second close", "Third close", "Fourth close"]) await saveFilter(context, { ...ANY_CLOSE, name });
    let dialog = await openNewPlan(page);
    await expect(dialog.getByRole("heading", { name: PRACTICE_COPY.newPlanTitle })).toBeVisible();

    // Balance and mode: a bounded number field with SIMULATED, and the two modes.
    const balance = dialog.getByLabel("Starting balance");
    await expect(balance).toHaveValue("50000");
    await expect(balance).toHaveAttribute("type", "number");
    await expect(balance).toHaveAttribute("min", "1000");
    await expect(balance).toHaveAttribute("max", "10000000");
    await expect(dialog.getByText(PRACTICE_COPY.threadSimulated, { exact: true }).first()).toBeVisible();
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

    // The rest of the form is on screen: dates (with the recorded-day note), list time and size, window, arming, and the open risk plan.
    await expect(dialog.getByTestId("first-day-note")).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Days" }).getByRole("button")).toHaveText(["5", "10", "20", "30"]);
    await expect(dialog.getByRole("group", { name: PRACTICE_COPY.planMaxSymbols }).getByRole("button")).toHaveText(["1", "2", "3", "4", "5"]);
    await expect(dialog.getByRole("switch", { name: PRACTICE_COPY.planHideDates })).toBeChecked();
    await expect(dialog.getByRole("group", { name: PRACTICE_COPY.planListAt }).getByRole("button")).toHaveCount(3);
    await expect(dialog.getByLabel(PRACTICE_COPY.planListSize)).toHaveValue("30");
    await expect(dialog.getByRole("group", { name: "Window (ET)" })).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Arm strategies" })).toBeVisible();
    const risk = dialog.getByRole("group", { name: PRACTICE_COPY.newPlanRiskTitle });
    for (const label of ["Max loss ($)", "Max trades"]) await expect(risk.getByLabel(label)).toBeVisible();
    await expect(risk.getByLabel(/^Plan note/)).toBeVisible();
    await expect(dialog.getByText(PRACTICE_COPY.newPlanFooter)).toBeVisible();
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true })).toBeEnabled();
    await expectCleanScreen(page);

    // Closes with Escape, with Close, and with a click on the dimmed page.
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

  test("Populate data waits for a filter and says what is wrong in the field", async ({ page, context }) => {
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    const submit = dialog.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true });
    await expect(submit).toBeDisabled();
    await expect(dialog.getByText(PRACTICE_COPY.planSaveFilterFirst)).toBeVisible();
    await fillNewPlan(dialog, { balance: "1000", maxLoss: "5000" });
    await expect(submit).toBeEnabled();
    await submit.click();
    // The contract's rule, shown under its field; nothing was created.
    await expect(dialog.getByRole("alert").filter({ hasText: "Max loss can't be more than your simulated starting balance" })).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Starting balance").fill("500");
    await submit.click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Starting balance: whole dollars" })).toBeVisible();
    expect((await (await context.request.get("/api/desk/replay/threads")).json()) as unknown[]).toHaveLength(0);
  });

  test("Populate data starts the thread and its plan, lands on the thread page, and Start Day 1 opens the day", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context, { balance: "25000", maxLoss: "600", maxTrades: "3", note: "Trade only clean pullbacks.", stop: true });
    const id = threadIdOf(page);
    await expect(page).toHaveURL(THREAD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("thread");
    const balance = page.getByRole("region", { name: "Thread balance" });
    await expect(balance).toContainText(formatBalance(25_000));
    await expect(balance).toContainText(PRACTICE_COPY.threadSimulated);
    for (const label of [PRACTICE_COPY.threadDaysPracticed, PRACTICE_COPY.threadSkipped, PRACTICE_COPY.threadWinRate, PRACTICE_COPY.threadAdherence]) {
      await expect(balance.getByText(label, { exact: true })).toBeVisible();
    }
    // The daily plan of this thread, with its armed filter; the dates stay hidden.
    const plan = page.getByRole("region", { name: "Daily list plan" });
    await expect(plan).toContainText("Day 1 of 5", { timeout: 60_000 }); // the data is prepared in the background first
    await expect(plan).toContainText("Any close");
    await expect(page.locator("body")).not.toContainText("2026-09-25");
    await expect(page.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${id}`);
    await expectCleanScreen(page);

    await openFirstDay(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 5");

    // Back on the landing: the thread has a row whose Continue is today's open day.
    await openDesk(page, "/practice");
    const row = page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel }).getByRole("row", { name: /Day trading/ });
    await expect(row).toContainText(formatBalance(25_000));
    await row.getByRole("link", { name: PRACTICE_COPY.planContinue, exact: true }).click();
    await page.waitForURL(DAY_URL);

    // The thread page is where she returns between days: today's day is a Continue link.
    await openDesk(page, `/practice/thread?id=${id}`);
    await expect(page.getByRole("region", { name: "Practice day" }).getByRole("link", { name: PRACTICE_COPY.planContinue, exact: true })).toBeVisible();
  });

  test("with a day thread active the modal keeps Day off and the thread page replaces its plan", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    const id = threadIdOf(page);
    await openDesk(page, "/practice");
    const dialog = await clickNewPlan(page);
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.threadModeDay })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByText("A day thread is already active")).toBeVisible();
    await page.keyboard.press("Escape");

    // Replace plan from the thread page: only the plan, the balance and risk plan stay with the thread.
    await openDesk(page, `/practice/thread?id=${id}`);
    await page.getByRole("button", { name: PRACTICE_COPY.threadPageReplace }).click();
    const replace = page.getByRole("dialog", { name: /^New plan for/ });
    await expect(replace).toBeVisible();
    await expect(replace.getByLabel("Starting balance")).toHaveCount(0);
    await expect(replace.getByRole("group", { name: PRACTICE_COPY.newPlanRiskTitle })).toHaveCount(0);
    await fillNewPlan(replace, { replace: true, days: "10" });
    await replace.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 90_000 });
    await expect(page.getByRole("region", { name: "Daily list plan" })).toContainText("Day 1 of 10", { timeout: 60_000 }); // the data is prepared in the background first
  });

  test("the thread page says so for a thread that does not exist", async ({ page }) => {
    await openDesk(page, "/practice/thread?id=999999");
    await expect(page.getByText(PRACTICE_COPY.threadPageNotFound)).toBeVisible();
    await openDesk(page, "/practice/thread");
    await expect(page.getByText(PRACTICE_COPY.threadPageNotFound)).toBeVisible();
  });
});
