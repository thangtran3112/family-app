import type { Page } from "@playwright/test";
import { expect, expectBacktestChrome, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { formatBalance, formatDayResult } from "../../lib/replay/threadView.ts";
import { START_BUTTON, clickNewPlan, createThreadByApi, openNewPlan, openRow, THREAD_URL } from "./hub-helpers";
import { DAY_ISO, FIRST_DAY, REPLAY, SYMBOLS, createSwingThread, enterByApi, expectNoDates, get, markByApi, openNextDay, railSection, replayRail, send, shot, swingRow, watchSwingAnswers, type Json } from "./swing-helpers";

const BOARD_URL = /\/practice\/day\?id=\d+/;
const SESSION_URL = /\/practice\/replay\?id=\d+/;
const playhead = (page: Page) => page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd");

test.describe("Swing practice", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a swing thread is created through the New plan modal, beside a day thread, and the modal asks for a universe only when Swing is picked", async ({ page, context }) => {
    const api = watchApi(page);
    const swingCalls = () => api.paths().filter((path) => path.includes("/swing-universe"));

    // A plain landing load, and the modal open in Day mode, never ask for a universe (it would start the data prep).
    let dialog = await openNewPlan(page);
    await expect(dialog.getByRole("radio", { name: PRACTICE_COPY.threadModeDay })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: PRACTICE_COPY.swingModeLabel, exact: true })).not.toBeChecked();
    await page.waitForTimeout(1_200);
    expect(swingCalls()).toEqual([]);
    await page.keyboard.press("Escape");

    // The day thread first (made by API: this spec is about the swing thread): both modes stay on offer (several threads of a mode can run).
    await createThreadByApi(context);
    await openDesk(page, "/practice");
    const table = page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel });
    await expect(table.getByRole("row", { name: /Day trading/ })).toContainText("$50,000");
    dialog = await clickNewPlan(page);
    await expect(dialog.getByRole("radio", { name: PRACTICE_COPY.threadModeDay })).toBeEnabled();
    await expect(dialog.getByRole("radio", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toBeEnabled();
    await expect(dialog.getByText("is already active")).toHaveCount(0);
    await dialog.getByRole("radio", { name: PRACTICE_COPY.swingModeLabel, exact: true }).click();
    await expect(dialog.getByRole("radio", { name: PRACTICE_COPY.swingModeLabel, exact: true })).toBeChecked();
    await expect(dialog.getByRole("button", { name: START_BUTTON })).toBeDisabled(); // no universe yet
    await expectCleanScreen(page);

    // Swing: the first day, 15 sessions, the twelve names by hand (liquidity off, so only her adds).
    await dialog.getByLabel("First day").fill(FIRST_DAY);
    await dialog.getByLabel("Sessions").fill("15");
    await dialog.getByRole("checkbox", { name: "Add by liquidity" }).uncheck();
    const adds = dialog.getByRole("group", { name: "Add symbols" });
    for (const symbol of SYMBOLS) {
      await adds.getByRole("combobox").fill(symbol);
      await adds.getByRole("combobox").press("Enter");
    }
    const universe = dialog.getByRole("table", { name: "Swing universe" });
    await expect(universe.getByRole("row")).toHaveCount(13, { timeout: 30_000 }); // header + twelve names
    await expect(dialog.getByText("As-of data is ready")).toBeVisible();
    await expect(dialog.getByText("12 symbols · 12 manual")).toBeVisible();
    await expect(dialog.getByText(/^Fixed universe · 12 symbols chosen today/)).toBeVisible(); // the survivorship label
    for (const symbol of SYMBOLS) await expect(universe.getByRole("row", { name: new RegExp(`^${symbol}\\b`) })).toContainText("Manual");
    expect(swingCalls().length).toBeGreaterThan(0);
    await shot(page, "swing-create");
    await expectCleanScreen(page);

    // Start swing thread lands on the thread page: the swing line with SIMULATED, and the day thread still has its row.
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    await page.waitForURL(THREAD_URL);
    await expectBacktestChrome(page, "Practice"); // ADR-0014: the thread page is Backtest mode
    const balance = page.getByRole("region", { name: "Thread balance" });
    await expect(balance).toContainText("Swing · 12 names · Week 1 of 3 · Day 1 of 15");
    await expect(balance).toContainText("$50,000.00");
    await expect(balance).toContainText("Equity $50,000");
    await expect(balance).toContainText(PRACTICE_COPY.threadSimulated);
    await openDesk(page, "/practice");
    const row = swingRow(page);
    await expect(row).toContainText("Swing · 12 names · Week 1 of 3 · Day 1 of 15");
    await expect(row).toContainText("$50,000.00"); // D-112: the balance sits in its own cell, not in the sub-line
    await expect(row).toContainText("Equity $50,000");
    await expect(row).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(table.getByRole("row", { name: /Day trading/ })).toBeVisible(); // both threads at once
    await shot(page, "swing-hub");
    await expectCleanScreen(page);

    // Start Day 1: the thread's data is still being prepared in the background, and the row says so until the day can open.
    const start = row.getByRole("button", { name: "Start Day 1" });
    await expect
      .poll(
        async () => {
          if (BOARD_URL.test(page.url())) return true;
          await start.click({ timeout: 2_000 }).catch(() => undefined);
          await page.waitForTimeout(500);
          return BOARD_URL.test(page.url());
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 1 of 15 · Mon");
    await expect(page.getByRole("table", { name: "Universe" }).getByRole("row")).toHaveCount(13);
    await expectNoDates(page);
  });
  test("Day 1: the board, two stars, the workspace, a long and a short, the messages, and End day", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    await openNextDay(context, threadId);
    await openDesk(page, "/practice");
    await swingRow(page).getByRole("button", { name: "Continue Day 1" }).click();
    await page.waitForURL(BOARD_URL);

    // The board: 12 names with their source tags, the survivorship label, no review, no list chips, no dates.
    // D-139: the title is the day and weekday; the week and the state are chips and the money is in the strip below.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Day 1 of 15 · Mon");
    await expect(page.getByText("Week 1", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("as of the prior close", { exact: true })).toBeVisible();
    const moneyStrip = page.getByRole("group", { name: "Practice thread" });
    await expect(moneyStrip).toContainText("Balance $50,000.00");
    await expect(moneyStrip).toContainText("Equity $50,000.00");
    const universe = page.getByRole("table", { name: "Universe" });
    await expect(universe.getByRole("row")).toHaveCount(13);
    await expect(universe.getByRole("row", { name: /S05/ })).toContainText("Manual");
    await expect(page.getByText(/^Fixed universe · 12 symbols chosen today/)).toBeVisible();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toHaveCount(0);
    await expect(page.getByText(/^List at /)).toHaveCount(0);
    await expect(page.getByText(PRACTICE_COPY.dayNoNames)).toHaveCount(0);
    await expect(page.getByText("No practice holds open")).toBeVisible();
    await expectNoDates(page);
    await shot(page, "swing-board");
    await expectCleanScreen(page);

    // Two stars; Start Day 1 opens the workspace on the first of them.
    await page.getByRole("button", { name: "Star S01" }).click();
    await expect(page.getByRole("button", { name: "Unstar S01" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Star S04" }).click();
    await expect(page.getByRole("button", { name: "Unstar S04" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Start Day 1" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();
    await expectNoDates(page);

    // The day strip: the two focus names; the tape is off and says so.
    const strip = page.getByRole("region", { name: "Day strip" });
    await expect(strip.getByRole("button")).toHaveCount(2);
    await expect(strip.getByRole("button", { name: /^S01, focus name/ })).toHaveAttribute("aria-current", "true");
    await expect(strip.getByRole("button", { name: /^S04, focus name/ })).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.swingTapeOff).first()).toBeVisible();
    await expect(page.getByText("Day 1 of 15 · Week 1 · Mon")).toBeVisible();
    await expect(page.getByRole("group", { name: "Practice thread" })).toContainText("Balance $50,000.00 · Equity $50,000.00 · Free cash $50,000.00");
    await expect(page.getByRole("group", { name: "Practice thread" })).toContainText(PRACTICE_COPY.threadSimulated);
    // M5: every rail section with dollars is labelled SIMULATED (the strip's hold P/L, the plan's week limits).
    await expect(strip.getByText(PRACTICE_COPY.threadSimulated, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Swing plan" }).getByText(PRACTICE_COPY.threadSimulated, { exact: true })).toBeVisible();

    // Before the first bar nothing can be entered.
    await expect(playhead(page)).toContainText("9:30");
    await page.keyboard.press("b");
    await expect(page.getByRole("alert").filter({ hasText: PRACTICE_COPY.swingMarketNotOpen })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss message" }).click();
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await expect(playhead(page)).not.toContainText("9:30:00");

    // A long on S01 with a stop typed in the mark box; too many shares says what the cash covers.
    const practice = await replayRail(page, "Practice");
    await practice.getByLabel("Shares").fill("1000");
    await practice.getByRole("button", { name: "Long (B)" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Not enough practice cash · $50,000 free" })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss message" }).click();
    await practice.getByLabel("Shares").fill("100");
    await practice.getByLabel("Stop price (optional)").fill("95");
    await practice.getByRole("button", { name: "Long (B)" }).click();
    await expect(practice.getByRole("definition").filter({ hasText: "Long 100" })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^S01, practice hold/ })).toContainText("Long 100");
    await shot(page, "swing-workspace", false);
    await expectNoDates(page);
    await expectCleanScreen(page);

    // Switch to S04 from the strip (the S01 hold stays open) and enter a short.
    await strip.getByRole("button", { name: /^S04, focus name/ }).click();
    await expect(page.getByRole("heading", { name: "S04", level: 1 })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^S04, focus name/ })).toHaveAttribute("aria-current", "true");
    await expect(strip.getByRole("button", { name: /^S01, practice hold/ })).toBeVisible();
    const practice4 = await replayRail(page, "Practice");
    await practice4.getByLabel("Shares").fill("100");
    await practice4.getByLabel("Stop price (optional)").fill("85");
    await practice4.getByRole("button", { name: "Short (S)" }).click();
    await expect(practice4.getByRole("definition").filter({ hasText: "Short 100" })).toBeVisible();
    await expect(strip.getByRole("button", { name: /^S04, practice hold/ })).toContainText("Short 100");
    await expect(page.getByRole("group", { name: "Practice thread" })).toContainText("Free cash $");
    await expect(page.getByText("Open holds").locator("xpath=following-sibling::*").first()).toContainText("2 of 5");

    // The hold cap: three more holds by API fill the five a thread may carry; a sixth is refused in words.
    const dayListId = Number(new URL(page.url()).searchParams.get("id") && (await get(context, `/threads/${threadId}`)).today.day_list_id);
    await send(context, "PATCH", `/day-lists/${dayListId}`, { watch: ["S01", "S04", "S05", "S06", "S07"] });
    for (const symbol of ["S05", "S06", "S07"]) await markByApi(context, dayListId, symbol, { kind: "long_entry", shares: 100 });
    await send(context, "PATCH", `/day-lists/${dayListId}`, { watch: ["S01", "S04", "S05", "S06", "S08"] });
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await expect(strip.getByRole("button", { name: /practice hold/ })).toHaveCount(5);
    await strip.getByRole("button", { name: /^S08, focus name/ }).click();
    await expect(page.getByRole("heading", { name: "S08", level: 1 })).toBeVisible();
    const practice8 = await replayRail(page, "Practice");
    await practice8.getByRole("button", { name: "Long (B)" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Five practice holds is the most at once" })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss message" }).click();
    await expect(strip.getByRole("button", { name: /practice hold/ })).toHaveCount(5);

    // End day: it asks first and says the holds stay open.
    await page.getByRole("button", { name: "End day…" }).click();
    const confirm = page.getByRole("group", { name: "Confirm ending the day" });
    await expect(confirm).toContainText("Your 5 holds stay open through the close, unwatched.");
    await shot(page, "swing-end-prompt", false);
    await confirm.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByText("Day over", { exact: true }).first()).toBeVisible(); // D-139: the state is a chip beside the title
    await expectNoDates(page);
    await shot(page, "swing-day-ended");
    const summary = page.getByRole("region", { name: "Day summary" });
    await expect(summary).toContainText("5 · 0"); // five entries, no exit: nothing is credited yet
    await expect(summary).toContainText("Starred after the open: S05, S06, S08");
    await expect(page.getByRole("table", { name: "Practice holds" }).getByRole("row")).toHaveCount(6);
    expect((await get(context, `/threads/${threadId}`)).thread.stats.balance).toBe(50_000);
  });
  test("Days 2 and 3: Pass with its confirm, a watched day with an exit, and the ledger rule for balance and equity", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayOne = await openNextDay(context, threadId);
    await enterByApi(context, dayOne, { symbol: "S01", watch: ["S01", "S04"], day: DAY_ISO[0]!, stopPrice: 95 });
    await markByApi(context, dayOne, "S04", { kind: "long_entry", shares: 100 });
    await send(context, "POST", `/day-lists/${dayOne}/end`);
    const afterOne = (await get(context, `/threads/${threadId}`)).swing;
    expect(afterOne.balance_usd ?? 50_000).toBe(50_000);

    await openDesk(page, "/practice");
    const row = swingRow(page);
    await expect(row).toContainText("Day 2 of 15");
    await expect(row).toContainText("2 holds open");
    await row.getByRole("button", { name: "Continue Day 2" }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 15 · Tue");
    const holds = page.getByRole("table", { name: "Practice holds" });
    await expect(holds.getByRole("row")).toHaveCount(3);

    // Pass asks first and says the holds ride through unwatched.
    await page.getByRole("button", { name: "Pass this day" }).click();
    const confirm = page.getByRole("group", { name: "Confirm passing the day" });
    await expect(confirm).toContainText("Your 2 holds ride through Day 2 unwatched.");
    await confirm.getByRole("button", { name: "Pass this day" }).click();
    await expect(page.getByText("Day over", { exact: true }).first()).toBeVisible(); // D-139: the state is a chip beside the title
    const summary = page.getByRole("region", { name: "Day summary" });
    await expect(summary).toContainText("Passed");
    await expect(summary).toContainText("$50,000"); // nothing was exited: the balance did not move
    await expect(summary).toContainText("0 · 0");
    await shot(page, "swing-day-passed");
    await expectNoDates(page);

    // Day 3: a watched day. No star is needed: Start Day 3 opens the first practice hold.
    await page.getByRole("button", { name: "Continue Day 3" }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 3 of 15 · Wed");
    await page.getByRole("button", { name: "Start Day 3" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();
    const strip = page.getByRole("region", { name: "Day strip" });
    await expect(strip.getByRole("button")).toHaveCount(2);
    await page.getByRole("button", { name: "Step", exact: true }).click();
    const money = page.getByRole("group", { name: "Practice thread" });
    await expect(money).toContainText("Balance $50,000.00 · Equity $50,184");
    const practice = await replayRail(page, "Practice");
    await practice.getByRole("button", { name: "Exit (X)" }).click();
    await expect(practice.getByText("No open practice hold")).toBeVisible();
    // The ledger rule: an exit credits the balance only when its day ends. Free cash is back at once; the strip drops the exited name.
    await expect(strip.getByRole("button")).toHaveCount(1);
    await expect(strip.getByRole("button", { name: /^S04, practice hold/ })).toBeVisible();
    await expect(money).toContainText("Balance $50,000.00 · Equity $50,184");
    await expect(money).not.toContainText("Free cash $31,");
    const mid = await get(context, `/threads/${threadId}`);
    expect(mid.thread.stats.balance).toBe(50_000);
    expect((await get(context, `/threads/${threadId}/ledger`)).total).toBe(0);

    await page.getByRole("button", { name: "End day…" }).click();
    const confirmEnd = page.getByRole("group", { name: "Confirm ending the day" });
    await expect(confirmEnd).toContainText("Your 1 hold stays open through the close, unwatched.");
    await confirmEnd.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByText("Day over", { exact: true }).first()).toBeVisible(); // D-139: the state is a chip beside the title

    // After the exit day ends the balance holds the realized P/L and the equity adds the carried S04.
    const closed = (await get(context, `/threads/${threadId}/holds?status=closed`)).holds as Json[];
    const open = (await get(context, `/threads/${threadId}/holds?status=open`)).holds as Json[];
    expect(closed.map((hold) => hold.symbol)).toEqual(["S01"]);
    expect(open.map((hold) => hold.symbol)).toEqual(["S04"]);
    const balance = 50_000 + closed[0].pnl_usd;
    const equity = balance + open[0].unrealized_usd;
    expect(closed[0].pnl_usd).toBeGreaterThan(0);
    expect((await get(context, `/threads/${threadId}`)).thread.stats.balance).toBeCloseTo(balance, 2);
    await expect(page.getByRole("group", { name: "Practice thread" })).toContainText(`Balance ${formatBalance(balance)}`);
    await expect(page.getByRole("group", { name: "Practice thread" })).toContainText(`Equity ${formatBalance(equity)}`);
    const ended = page.getByRole("region", { name: "Day summary" });
    await expect(ended).toContainText("0 · 1");
    await expect(page.getByRole("table", { name: "Practice holds" }).getByRole("row", { name: /^S01/ })).toContainText("Exit Day 3");
    await expectNoDates(page);
    await shot(page, "swing-day-exit");

    // C1: Day 3 has ended but the thread goes on. Its journal (the landing no longer lists sessions: opened by id, the newest S01
    // one) names the day by number and weekday, in the title, the Practice band and the badge: one date would give every later day's.
    const sessions = (await get(context, "/sessions?limit=20")) as Json[];
    await openDesk(page, `/practice/journal?id=${sessions.find((row) => row.symbol === "S01")!.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/^S01 · Day \d of 15 · Week 1 · (Mon|Tue|Wed) · attempt 1 · Practice journal$/);
    await expect(page.getByRole("heading", { name: "Chart", level: 2 })).toBeVisible();
    await expectNoDates(page);
    await shot(page, "swing-session-journal");
  });
  test("the S03 split morning keeps a carried hold's P/L, and the S02 gap through a stop pauses the first advance", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayOne = await openNextDay(context, threadId);
    await enterByApi(context, dayOne, { symbol: "S02", watch: ["S02", "S03"], day: DAY_ISO[0]!, stopPrice: 86 });
    await markByApi(context, dayOne, "S03", { kind: "long_entry", shares: 100 });
    await send(context, "POST", `/day-lists/${dayOne}/end`);
    for (let day = 2; day <= 5; day++) await send(context, "POST", `/day-lists/${await openNextDay(context, threadId)}/end`);
    const beforeSplit = ((await get(context, `/threads/${threadId}/holds?status=open`)).holds as Json[]).find((hold) => hold.symbol === "S03")!;

    // Day 6, Mon: S03 splits 2 for 1 before the open. The board says so and the carried hold's P/L did not change.
    const dayList = await openNextDay(context, threadId);
    await openDesk(page, `/practice/day?id=${dayList}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 6 of 15 · Mon");
    const holds = page.getByRole("table", { name: "Practice holds" });
    const row = holds.getByRole("row", { name: /^S03/ });
    await expect(row).toContainText("200");
    await expect(row).toContainText("Split 2-for-1 before today's open · 100 shares are now 200");
    await expect(row).toContainText(formatDayResult(beforeSplit.unrealized_usd)); // the split changed nothing about what she is up or down
    const afterSplit = ((await get(context, `/threads/${threadId}/holds?status=open`)).holds as Json[]).find((hold) => hold.symbol === "S03")!;
    expect(afterSplit.shares).toBe(200);
    expect(afterSplit.unrealized_usd).toBeCloseTo(beforeSplit.unrealized_usd, 1);
    await shot(page, "swing-split-morning");

    // Pass Day 6 and open Day 7 (Tue): S02 gaps down 8% at the open, through its 86.00 stop.
    await page.getByRole("button", { name: "Pass this day" }).click();
    await page.getByRole("group", { name: "Confirm passing the day" }).getByRole("button", { name: "Pass this day" }).click();
    await page.getByRole("button", { name: "Continue Day 7" }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 7 of 15 · Tue");
    await expectNoDates(page);
    await page.getByRole("button", { name: "Start Day 7" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S02", level: 1 })).toBeVisible();
    const strip = page.getByRole("region", { name: "Day strip" });
    await expect(strip.getByRole("button", { name: /^S02, practice hold/ })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "opened below your stop" })).toHaveCount(0);

    // Play: the first advance runs into the gap and stops there.
    await page.keyboard.press("4");
    await page.keyboard.press("Space");
    const toast = page.getByRole("alert").filter({ hasText: "opened below your stop" });
    await expect(toast).toBeVisible({ timeout: 20_000 }); // 10x: the first minute bar closes 6 seconds after the open
    await expect(toast).toContainText(/^S02 opened below your stop 86\.00 at 8\d\.\d\d/);
    await expect(toast).toContainText("Exit or keep");
    await expect(page.getByText(/^Paused at 9:3\d AM/)).toBeVisible();
    await expect(page.getByText(/^Playing at/)).toHaveCount(0);
    await expect(strip.getByRole("button", { name: /^S02, practice hold/ })).toHaveAttribute("data-amber", "true");
    await shot(page, "swing-stop-pause", false);
    await expectNoDates(page);
    await expectCleanScreen(page);

    // Exit books a normal exit at the revealed price.
    await toast.getByRole("button", { name: "Exit S02" }).click();
    await expect(toast).toHaveCount(0);
    await expect(strip.getByRole("button")).toHaveCount(1); // the S03 hold is left
    const exited = ((await get(context, `/threads/${threadId}/holds?status=closed`)).holds as Json[])[0]!;
    expect(exited.symbol).toBe("S02");
    expect(exited.exit_source).toBe("her");
    expect(exited.exit_price).toBeLessThan(86);
    expect(exited.exit_price).toBeGreaterThan(80);
    expect(exited.stop_hit).toBe("yes");
    expect(exited.pnl_usd).toBeLessThan(-300);

    await page.getByRole("button", { name: "End day…" }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.waitForURL(BOARD_URL);
    const summary = page.getByRole("region", { name: "Day summary" });
    await expect(summary).toContainText("0 · 1");
    await expect(summary.getByRole("list", { name: "Stop crossings" })).toContainText(/^S02 crossed its stop at 09:3\d/);
    await expect(summary).toContainText(formatDayResult(exited.pnl_usd));
    await expectNoDates(page);
  });
  test("Week 1 review: tiles, tables, heat strip, notes that persist, and Start Week 2; the open week is Week to date", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayOne = await openNextDay(context, threadId);
    await enterByApi(context, dayOne, { symbol: "S01", watch: ["S01", "S04"], day: DAY_ISO[0]!, stopPrice: 95 });
    await markByApi(context, dayOne, "S04", { kind: "long_entry", shares: 100 });
    await send(context, "POST", `/day-lists/${dayOne}/end`);
    for (let day = 2; day <= 5; day++) {
      const list = await openNextDay(context, threadId);
      if (day === 4) await markByApi(context, list, "S01", { kind: "long_exit" }, { day: DAY_ISO[3]!, to: "09:35" }); // the gap-up morning
      await send(context, "POST", `/day-lists/${list}/end`);
    }

    // The landing: the week is ready, there is no Continue until she has seen it. The thread page says so too.
    await openDesk(page, "/practice");
    const row = swingRow(page);
    await expect(row.getByRole("button", { name: /^Continue Day/ })).toHaveCount(0);
    // 5R: the owed review is not a row action. The row says it is due, its one link is the thread's own, and the overview carries the review.
    await expect(row.getByRole("link", { name: "Open Week 1 review" })).toHaveCount(0);
    await expect(row).toContainText("Week 1 review due");
    await expect(row.getByRole("link")).toHaveCount(1);
    await expect(row.getByRole("link", { name: "Overview" })).toHaveCount(0); // the row itself is the way to the thread page
    await openRow(page, row);
    await expect(page.getByRole("button", { name: /^Continue Day/ })).toHaveCount(0);
    await expect(page.getByText("Week 1 is done. Review it to unlock Day 6.")).toHaveCount(1); // D-085: said once
    await shot(page, "swing-hub-review-ready");
    await page.getByRole("region", { name: "Practice day" }).getByRole("link", { name: "Week 1 review", exact: true }).click();
    await page.waitForURL(new RegExp(`/practice/week\\?thread=${threadId}&week=1`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Week 1 · 5 days");
    await expectBacktestChrome(page, "Practice"); // the week review highlights Practice (design-modes-cutover Q9)
    await expect(page.getByText(/^Final/)).toBeVisible(); // "Final · N holds open" while holds ride on (D-130)
    await expect(page.getByText("Days 1 to 5", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Fixed universe · 12 symbols chosen today/)).toBeVisible();
    await shot(page, "swing-week");
    await expectNoDates(page);
    await expectCleanScreen(page);

    // The tiles and the sentence are the API's own numbers.
    const week = await get(context, `/threads/${threadId}/weeks/1`);
    const tiles = week.review.tiles;
    const tile = (label: string) => page.getByRole("listitem").filter({ hasText: new RegExp(`^${label}\\s*:`) });
    expect(tiles.realized_usd).toBeGreaterThan(500);
    await expect(tile("Realized")).toContainText(formatDayResult(tiles.realized_usd));
    await expect(tile("Unrealized change")).toContainText(formatDayResult(tiles.unrealized_change_usd));
    await expect(tile("Equity change")).toContainText(formatDayResult(tiles.equity_change_usd));
    await expect(tile("Balance")).toContainText(formatBalance(tiles.balance_usd));
    await expect(tile("Win rate")).toContainText("100%");
    await expect(tile("Adherence")).toContainText("100%");
    await expect(tile("SPY")).toBeVisible();
    await expect(page.getByText(week.review.copy[0], { exact: true })).toBeVisible();
    expect(week.review.copy[0]).toMatch(/^Selection .* vs the universe median/);

    // Days, holds, the heat strip.
    const days = page.getByRole("table", { name: "Days this week" });
    await expect(days.getByRole("row")).toHaveCount(6);
    await expect(days.getByRole("row", { name: /^Day 4 · Thu/ })).toContainText("Watched");
    await expect(days.getByRole("row", { name: /^Day 5 · Fri/ })).toContainText("Passed");
    const exited = ((await get(context, `/threads/${threadId}/holds?status=closed`)).holds as Json[])[0]!;
    const holds = page.getByRole("table", { name: "Holds this week" });
    await expect(holds.getByRole("row")).toHaveCount(3);
    await expect(holds.getByRole("row", { name: /^S01/ })).toContainText(`Day 4 · ${exited.exit_price.toFixed(2)}`);
    await expect(holds.getByRole("row", { name: /^S01/ })).toContainText(formatDayResult(exited.pnl_usd));
    await expect(holds.getByRole("row", { name: /^S04/ })).toContainText("open · Fri close");
    const heat = page.getByRole("list", { name: "Universe names by week return, best first" });
    await expect(heat.getByRole("listitem")).toHaveCount(12);
    await expect(heat.getByRole("listitem").first()).toContainText("S01");
    await expect(heat.getByRole("listitem").first()).toContainText("Held");
    await expect(page.getByText(/^Adherence 100%/)).toBeVisible();

    // Notes and the rating persist across a reload.
    await page.getByLabel("Week notes").fill("Held through the gap.");
    await page.getByRole("button", { name: "Save notes" }).click();
    await expect(page.getByText(PRACTICE_COPY.notesSaved)).toBeVisible();
    await page.getByRole("radio", { name: "4" }).click();
    await expect(page.getByRole("radio", { name: "4" })).toBeChecked();
    await expect.poll(async () => (await get(context, `/threads/${threadId}/weeks/1`)).rating).toBe(4);
    await page.reload();
    await expect(page.getByLabel("Week notes")).toHaveValue("Held through the gap.");
    await expect(page.getByRole("radio", { name: "4" })).toBeChecked();
    expect(await get(context, `/threads/${threadId}/weeks/1`)).toMatchObject({ notes: "Held through the gap.", rating: 4 });

    // Start Week 2 opens Day 6's board.
    await page.getByRole("button", { name: "Start Week 2" }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 6 of 15 · Mon");
    await expectNoDates(page);

    // The open week reads "to date": after Day 6 the board links to it.
    await page.getByRole("button", { name: "Pass this day" }).click();
    await page.getByRole("group", { name: "Confirm passing the day" }).getByRole("button", { name: "Pass this day" }).click();
    await page.getByRole("link", { name: "Open Week 2 review" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Week 2 to date");
    await expect(page.getByText("Week to date", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Through the last finished day's close · not final yet")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Start Week/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Day 7" })).toHaveCount(0); // Day 7 has no board yet
    await expect(page.getByRole("link", { name: "← Thread" })).toHaveAttribute("href", `/practice/thread?id=${threadId}`); // D-088, D-089: back to the thread's page, not the journal
    await expectNoDates(page);

    // Once Day 7 is open, the same review goes back to its board.
    const dayList7 = await openNextDay(context, threadId);
    await openDesk(page, `/practice/week?thread=${threadId}&week=2`);
    await expect(page.getByRole("link", { name: "Back to Day 7" })).toHaveAttribute("href", `/practice/day?id=${dayList7}`);
    await page.getByRole("link", { name: "Back to Day 7" }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 7 of 15 · Tue");
  });
  test("acceptance: nothing past the day clock reaches the browser, a carried hold hand-checks, and the thread closes at the last close", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayOne = await openNextDay(context, threadId);
    await enterByApi(context, dayOne, { symbol: "S01", watch: ["S01", "S04"], day: DAY_ISO[0]!, stopPrice: 95 });
    await markByApi(context, dayOne, "S04", { kind: "long_entry", shares: 100 });
    await send(context, "POST", `/day-lists/${dayOne}/end`);
    await send(context, "POST", `/day-lists/${await openNextDay(context, threadId)}/end`);
    const carried = ((await get(context, `/threads/${threadId}/holds?status=open`)).holds as Json[]).find((hold) => hold.symbol === "S04")!;

    const answers = watchSwingAnswers(page);
    const api = watchApi(page);
    await openDesk(page, "/practice");
    await swingRow(page).getByRole("button", { name: "Continue Day 3" }).click();
    await page.waitForURL(BOARD_URL);
    // Peek at a name before the open: daily bars through the prior close only.
    await page.getByRole("table", { name: "Universe" }).getByRole("row", { name: /S05/ }).getByText("S05", { exact: true }).click();
    await expect(page.getByRole("region", { name: "S05 1d market chart" })).toBeVisible();
    await page.getByRole("button", { name: "Start Day 3" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();

    // Work the day: step, jump an hour, read the Daily chart, the 5m chart, then the other hold.
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await page.getByRole("button", { name: /^Jump/ }).click();
    await page.getByRole("menuitem", { name: "+1 hour" }).click();
    await expect(page.getByText(/^Paused at 11:/)).toBeVisible();
    const toggle = page.getByRole("group", { name: "Chart interval" });
    await toggle.getByRole("button", { name: "Daily", exact: true }).click();
    const dailyChart = page.getByRole("region", { name: "S01 1d market chart" });
    await expect(dailyChart).toBeVisible();
    // M4: with dates hidden the chart's data table names its rows "D-1" ... "Today", not stand-in times of day.
    await dailyChart.getByText(/^Chart data table/).click();
    await expect(dailyChart.getByRole("rowheader", { name: "Today" })).toBeVisible();
    await expect(dailyChart.getByRole("rowheader", { name: "D-1", exact: true })).toBeVisible();
    await expect(dailyChart.getByRole("rowheader", { name: /AM|PM/ })).toHaveCount(0);
    await toggle.getByRole("button", { name: "5m", exact: true }).click();
    await expect(page.getByRole("region", { name: "S01 5m market chart" })).toBeVisible();
    await toggle.getByRole("button", { name: "15m", exact: true }).click();
    const strip = page.getByRole("region", { name: "Day strip" });
    await strip.getByRole("button", { name: /^S04, practice hold/ }).click();
    await expect(page.getByRole("heading", { name: "S04", level: 1 })).toBeVisible();
    await toggle.getByRole("button", { name: "Daily", exact: true }).click();
    await expect(page.getByRole("region", { name: "S04 1d market chart" })).toBeVisible();
    await toggle.getByRole("button", { name: "15m", exact: true }).click();
    await expectNoDates(page);
    await expectCleanScreen(page);

    // Everything the browser was told stops at the day clock.
    const day = DAY_ISO[2]!;
    const sessionAnswers = answers.filter(({ path }) => /\/sessions\/\d+\/(advance|feed|marks)/.test(path));
    expect(sessionAnswers.filter(({ path }) => /\/advance/.test(path)).length).toBeGreaterThan(2);
    expect(sessionAnswers.filter(({ path }) => /\/feed/.test(path)).length).toBeGreaterThan(2);
    let dailyBlocks = 0;
    for (const { path, body } of sessionAnswers) {
      const through = body.revealed_through ? Date.parse(body.revealed_through) : null;
      if (through === null) continue;
      for (const bar of (body.bars as Json[] | undefined) ?? []) {
        const span = body.interval === "5m" ? 300_000 : body.interval === "15m" ? 900_000 : 60_000;
        expect(Date.parse(bar.t) + span, `${path}: a bar that has not closed`).toBeLessThanOrEqual(through);
      }
      if (body.forming) expect(Date.parse(body.forming.t), `${path}: a forming bar that has not started`).toBeLessThanOrEqual(through);
      for (const row of ((body.prints as Json | undefined)?.rows ?? []) as Json[]) expect(Date.parse(row[0])).toBeLessThanOrEqual(through);
      for (const signal of (body.signals as Json[] | undefined) ?? []) expect(Date.parse(signal.bar_close)).toBeLessThanOrEqual(through);
      const daily = (body.daily ?? null) as Json | null;
      if (daily) {
        dailyBlocks += 1;
        for (const bar of daily.bars as Json[]) expect(bar.t < day, `${path}: a daily bar of ${bar.t}, the day itself`).toBe(true);
        if (daily.forming) {
          expect(daily.forming.t, `${path}: the forming daily candle is today's`).toBe(day);
          expect(Date.parse(`${daily.forming.t}T13:30:00Z`)).toBeLessThanOrEqual(through); // it opened at 9:30 ET at the latest
        }
      }
      if (body.daily_forming) expect(body.daily_forming.t).toBe(day);
      for (const row of (body.strip as Json[] | undefined) ?? []) expect(typeof row.symbol).toBe("string");
    }
    expect(dailyBlocks).toBeGreaterThan(0);
    // The day list and the holds read as of the prior close while the day is under way.
    const lists = answers.filter(({ path }) => /^\/day-lists\/\d+(\?|$)/.test(path));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.some(({ body }) => body.peek)).toBe(true);
    for (const { body } of lists) {
      expect(body.kind).toBe("swing");
      expect(body.day).toBe(day);
      expect(body.journal ?? null, "no summary before the day is over").toBeNull();
      for (const bar of (body.peek?.daily ?? []) as Json[]) expect(bar.t < day, `a peek bar of ${bar.t}, the day itself`).toBe(true);
    }
    for (const { path, body } of answers.filter(({ path }) => /\/holds/.test(path))) {
      for (const hold of body.holds as Json[]) expect(hold.status === "open" ? hold.last_close : 0, path).toBeGreaterThan(0);
    }
    expect(api.paths().filter((path) => /\/api\/desk\/(bars|technicals|quotes|charts)\b/.test(path)), "a swing screen never reads the live store").toEqual([]);

    // Hand-check the carried S04 hold from the API's own numbers: its P/L at the prior close is shares x (prior daily close - entry).
    const s04Session = Number(new URL(page.url()).searchParams.get("id"));
    const feed = (await get(context, `/sessions/${s04Session}/feed?interval=15m`)) as Json;
    const priorClose = feed.daily.bars.at(-1).c as number;
    const s04 = ((await get(context, `/threads/${threadId}/holds?status=open`)).holds as Json[]).find((hold) => hold.symbol === "S04")!;
    expect(s04.price_basis).toBe("prior_close");
    expect(s04.last_close).toBeCloseTo(priorClose, 2);
    expect(s04.unrealized_usd).toBeCloseTo(carried.shares * (s04.last_close - carried.entry_price), 2); // the mark is the close in whole cents (D-064)
    expect(priorClose).toBeGreaterThan(carried.entry_price); // S04 rises a little each day

    // Run the day to the close: both holds have a last price there, which is the close they leave at.
    await page.getByRole("button", { name: /^Jump/ }).click();
    await page.getByRole("menuitem", { name: "To the close" }).click();
    await expect(page.getByText(/^End Day 3 · 2 holds stay open overnight/)).toBeVisible();
    const lastOf = async (symbol: string) => {
      const label = (await strip.getByRole("button", { name: new RegExp(`^${symbol}, practice hold`) }).getAttribute("aria-label"))!;
      return Number(/last ([\d.]+)/.exec(label)![1]);
    };
    const lastS04 = await lastOf("S04");
    const lastS01 = await lastOf("S01");
    // Back on S01 (left at 11:00): it opens at the shared day clock, so it can be marked.
    await strip.getByRole("button", { name: /^S01, practice hold/ }).click();
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();
    await expect(playhead(page)).toContainText("4:00");

    // A thread cannot close while its day is open: the API says so in words, and so does the journal.
    const refused = await context.request.post(`${REPLAY}/threads/${threadId}/close`);
    expect(refused.status()).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain("End Day 3 first");
    await openDesk(page, `/practice/journal?thread=${threadId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Thread ·");
    await expect(page.getByText(PRACTICE_COPY.balanceNow)).toBeVisible();
    await shot(page, "swing-journal");
    const refusing = await railSection(page, "Thread details", PRACTICE_COPY.threadClose); // D-040: Close thread is its own section of the rail
    await refusing.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await refusing.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(refusing.getByText("End Day 3 first")).toBeVisible();
    expect((await get(context, `/threads/${threadId}`)).thread.status).toBe("active");
    await shot(page, "swing-journal-close-refused");

    // End the day from the board it opened on, then close the thread: the holds leave at that last close.
    await openDesk(page, `/practice/day?id=${(await get(context, `/threads/${threadId}`)).today.day_list_id}`);
    await page.getByRole("button", { name: "Resume Day 3" }).click();
    await page.waitForURL(SESSION_URL);
    // S01 was left at 11:00 while S04 ran to the close: it comes back at the shared day clock, not at its own old playhead.
    await expect(page.getByText(/^End Day 3 · 2 holds stay open overnight/)).toBeVisible();
    await expect(playhead(page)).toContainText("4:00");
    await page.getByRole("button", { name: "End day" }).click();
    await page.waitForURL(BOARD_URL);
    await expect(page.getByText("Day over", { exact: true }).first()).toBeVisible(); // D-139: the state is a chip beside the title
    await openDesk(page, `/practice/journal?thread=${threadId}`);
    const closePlan = await railSection(page, "Thread details", PRACTICE_COPY.threadClose);
    await closePlan.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await closePlan.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(page.getByRole("status").filter({ hasText: "This thread is closed" })).toBeVisible();

    const holds = (await get(context, `/threads/${threadId}/holds?status=closed`)).holds as Json[];
    expect(holds.map((hold) => hold.symbol).sort()).toEqual(["S01", "S04"]);
    const entry = (symbol: string) => holds.find((hold) => hold.symbol === symbol)!;
    for (const [symbol, last] of [["S01", lastS01], ["S04", lastS04]] as const) {
      const hold = entry(symbol);
      expect(hold.exit_source).toBe("auto");
      expect(hold.exit_day_no).toBe(3);
      expect(hold.exit_price, `${symbol} leaves at the last close`).toBeCloseTo(last, 2);
      expect(hold.pnl_usd).toBeCloseTo(hold.shares * (hold.exit_price - hold.entry_price), 1);
    }
    const ledger = await get(context, `/threads/${threadId}/ledger`);
    expect(ledger.total).toBe(2);
    expect(ledger.entries.map((row: Json) => row.holdId).sort()).toEqual(holds.map((hold) => hold.id).sort());
    const closed = await get(context, `/threads/${threadId}`);
    expect(closed.thread.status).toBe("closed");
    expect(closed.thread.stats.balance).toBeCloseTo(50_000 + holds.reduce((sum, hold) => sum + hold.pnl_usd, 0), 1);
    await expectNoDates(page);
  });
  test("a stop pause on another name: Exit on the toast books that name's exit and shows it", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayOne = await openNextDay(context, threadId);
    await enterByApi(context, dayOne, { symbol: "S02", watch: ["S02", "S03"], day: DAY_ISO[0]!, stopPrice: 86 });
    await markByApi(context, dayOne, "S03", { kind: "long_entry", shares: 100 });
    await send(context, "POST", `/day-lists/${dayOne}/end`);
    for (let day = 2; day <= 6; day++) await send(context, "POST", `/day-lists/${await openNextDay(context, threadId)}/end`);
    const dayList = await openNextDay(context, threadId); // Day 7, Tue: S02 gaps through its stop
    await send(context, "PATCH", `/day-lists/${dayList}`, { watch: ["S03"] });
    await openDesk(page, `/practice/day?id=${dayList}`);
    await page.getByRole("button", { name: "Start Day 7" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S03", level: 1 })).toBeVisible();

    await page.keyboard.press("4");
    await page.keyboard.press("Space");
    const toast = page.getByRole("alert").filter({ hasText: "opened below your stop" });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText("S02 opened below your stop 86.00");
    await toast.getByRole("button", { name: "Exit S02" }).click();
    await expect(page.getByRole("heading", { name: "S02", level: 1 })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "opened below your stop" })).toHaveCount(0);
    const closed = (await get(context, `/threads/${threadId}/holds?status=closed`)).holds as Json[];
    expect(closed.map((hold) => hold.symbol)).toEqual(["S02"]);
    expect(closed[0]!.exit_price).toBeLessThan(86);
    await expectNoDates(page);
  });
  test("a name left behind the day clock comes back at the clock: from the strip and from Resume Day, and a mark is accepted", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayList = await openNextDay(context, threadId);
    await send(context, "PATCH", `/day-lists/${dayList}`, { watch: ["S01", "S02"] });
    await openDesk(page, `/practice/day?id=${dayList}`);
    await page.getByRole("button", { name: "Start Day 1" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();
    const strip = page.getByRole("region", { name: "Day strip" });
    const jumpTo = async (hhmm: string) => {
      await page.getByRole("button", { name: /^Jump/ }).click();
      await page.getByLabel("To a time (ET)").fill(hhmm);
      await page.getByRole("button", { name: "Go", exact: true }).click();
    };

    // S01 to 10:00; S02 opens at that clock and runs on to 11:00; S01 is then an hour behind.
    await jumpTo("10:00");
    await expect(playhead(page)).toContainText("10:00");
    await strip.getByRole("button", { name: /^S02, focus name/ }).click();
    await expect(page.getByRole("heading", { name: "S02", level: 1 })).toBeVisible();
    await expect(playhead(page)).toContainText("10:00");
    await jumpTo("11:00");
    await expect(playhead(page)).toContainText("11:00");

    // Back on S01 from the strip: its header reads the day clock and a mark is accepted.
    await strip.getByRole("button", { name: /^S01, focus name/ }).click();
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();
    await expect(playhead(page)).toContainText("11:00");
    const practice = await replayRail(page, "Practice");
    await practice.getByLabel("Shares").fill("100");
    await practice.getByRole("button", { name: "Long (B)" }).click();
    await expect(practice.getByRole("definition").filter({ hasText: "Long 100" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "behind the day clock" })).toHaveCount(0);

    // S02 runs on to 12:00; Resume Day 1 on the board asks for S01's session at the clock and a mark is accepted there too.
    await strip.getByRole("button", { name: /^S02, focus name/ }).click();
    await expect(page.getByRole("heading", { name: "S02", level: 1 })).toBeVisible();
    await jumpTo("12:00");
    await expect(playhead(page)).toContainText("12:00");
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(BOARD_URL);
    await page.getByRole("button", { name: "Resume Day 1" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();
    await expect(playhead(page)).toContainText("12:00");
    const practiceAgain = await replayRail(page, "Practice");
    await practiceAgain.getByRole("button", { name: "Exit (X)" }).click();
    await expect(practiceAgain.getByText("No open practice hold")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "behind the day clock" })).toHaveCount(0);
    const closed = (await get(context, `/threads/${threadId}/holds?status=closed`)).holds as Json[];
    expect(closed.map((hold) => hold.symbol)).toEqual(["S01"]);
    await expectNoDates(page);
  });
});
