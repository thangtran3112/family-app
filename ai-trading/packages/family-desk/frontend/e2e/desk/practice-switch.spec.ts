import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, prepareDesk, test } from "./helpers";
import { START_BUTTON, THREAD_URL, fillNewPlan, openFirstDay, openNewPlan, saveFilter, setRiskPlan, threadIdOf } from "./hub-helpers";

// Switching names on the shared day clock (02o-b2). The stub holds TSLA on Fri 2026-09-25, and three stand-in names that
// replay TSLA's day at a fraction of its prices (`replay/fixture.py`), so one daily list holds four names. Every session
// replays 09:30 to 09:40 ET at 1-minute bars; ArrowRight is one bar.

const DAY = "2026-09-25";
const FIRST_RECORDED = "2026-09-18"; // 20 finished sessions before the E2E clock
const SESSION_URL = /\/practice\/replay\?id=\d+/;

const playhead = (page: Page) => page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd");

/** The marks she has placed on the name on screen (the bottom panel is collapsed at 1180 until its tab opens). */
async function marks(page: Page) {
  await page.getByRole("tab", { name: "Marks" }).click();
  return page.getByRole("tabpanel");
}

/** The day's portfolio in the replay: the left rail at 1440, the right drawer's "Portfolio" tab at 1180. */
async function portfolioPanel(page: Page) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
  const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.dayPortfolio });
  if (!(await drawer.isVisible())) await page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** The day's portfolio on the day page: the left rail at 1440, the right drawer's "Portfolio" tab at 1180. */
async function dayPagePortfolio(page: Page) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: "Practice side panel" }).getByRole("region", { name: PRACTICE_COPY.dayPortfolio, exact: true });
  const drawer = page.getByRole("dialog", { name: PRACTICE_COPY.dayPortfolio });
  if (!(await drawer.isVisible())) await page.getByRole("tablist", { name: "Day context" }).getByRole("tab", { name: PRACTICE_COPY.dayPortfolio }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** The Desk "recorded" these mornings' universes (`universe_days`); the e2e server writes the rows the premarket pass would. */
async function recordUniverse(context: BrowserContext, days: { day: string; symbols: string[] }[]) {
  expect((await context.request.post(`${origin}/api/desk/__e2e/universe-days`, { data: { days } })).ok()).toBeTruthy();
}

/** A filter that lists every name the stub has bars for, and a thread with a plan started through the New plan modal. */
async function startEveryNamePlan(page: Page, context: BrowserContext) {
  const all = {
    schemaVersion: 1,
    name: "Every name",
    watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
    liquidity: { minPrice: 1, minAvgVolume: 1 },
    when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
    maxResults: 50,
  };
  await saveFilter(context, all);
  const dialog = await openNewPlan(page);
  await fillNewPlan(dialog, { filter: "Every name" });
  await expect(dialog.getByText("Names a day"), "no cap on names to pick").toHaveCount(0);
  await dialog.getByRole("button", { name: START_BUTTON }).click();
  await page.waitForURL(THREAD_URL, { timeout: 90_000 });
  await setRiskPlan(context, threadIdOf(page)); // this spec is not about stops (D-060): Stop on every entry is No
  await openFirstDay(page);
}

test.describe("Practice: switching names", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a click opens a name at the day clock, a name left behind catches up, one trade is open at a time, and every list name opens", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    const table = page.getByRole("table", { name: "Candidates" });
    for (const symbol of ["TSLA", "LRCX", "PANW", "XOM"]) await expect(table.getByRole("row", { name: new RegExp(symbol) })).toBeVisible();

    // No star and no cap: a day opens any list name, and the portfolio starts empty.
    await expect(page.getByRole("button", { name: /star/i })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/names practiced today|limits a day|Starred \d+ of/);
    await expectCleanScreen(page);

    // Click TSLA's row: its chart opens at once. Take it three bars in, and take a trade.
    await table.getByRole("row", { name: /TSLA/ }).getByText("TSLA", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    for (let bar = 0; bar < 3; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:33");
    const tslaPlayhead = (await playhead(page).textContent()) ?? "";
    await page.keyboard.press("b");
    await expect(await marks(page)).toContainText("Practice long");

    // The portfolio shows it: TSLA is on now and Long.
    let portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(/Long \d+ @ \$/);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayOnNow);

    // One open trade a day: opening LRCX from the list is refused in plain words while TSLA is open, with a way to TSLA.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await table.getByRole("row", { name: /LRCX/ }).getByRole("button", { name: "Open LRCX" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Close your open TSLA practice trade before you switch to LRCX" })).toBeVisible();
    await page.getByRole("link", { name: "Go to TSLA" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await page.keyboard.press("x");
    await expect(await marks(page)).toContainText("Practice exit");

    // Opening LRCX takes the clock TSLA reached, not the window start.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await table.getByRole("row", { name: /LRCX/ }).getByText("LRCX", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(tslaPlayhead);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");
    const clock = (await playhead(page).textContent()) ?? "";
    await expectCleanScreen(page);

    // A new Long on LRCX joins the portfolio, and TSLA's row says why it cannot be switched to until LRCX is closed.
    await page.keyboard.press("b");
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText(/Long \d+ @ \$/);
    const tslaRow = portfolio.locator('[data-symbol="TSLA"] button');
    await expect(tslaRow).toHaveAttribute("aria-disabled", "true");
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText("Close LRCX first");
    await page.keyboard.press("x");
    await expect(portfolio.locator('[data-symbol="LRCX"]')).toContainText("Flat");
    await expect(tslaRow).not.toHaveAttribute("aria-disabled", "true");

    // TSLA stayed at 9:33 while the clock moved on: it is behind, says so, and cannot be marked until it catches up.
    portfolio = await portfolioPanel(page);
    await expect(portfolio.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayBehind);
    await expect(portfolio.locator("li")).toHaveCount(2);
    await portfolio.getByRole("button", { name: "Switch to TSLA" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(tslaPlayhead);
    const banner = page.getByTestId("behind-clock");
    await expect(banner).toContainText("TSLA is behind the day clock");
    await expect(page.getByRole("button", { name: /^Long/ }).first()).toBeDisabled();
    await page.keyboard.press("b");
    await expect((await marks(page)).getByText("Practice long")).toHaveCount(1); // still only the first trade
    await expectCleanScreen(page);

    // Catch up: the playhead lands on the clock and the banner goes. Then it can be marked again.
    await banner.getByRole("button", { name: PRACTICE_COPY.replayCatchUp }).click();
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await expect(playhead(page)).toHaveText(clock);
    await page.keyboard.press("b");
    await expect((await marks(page)).getByText("Practice long")).toHaveCount(2); // the first trade and the one after catching up
    await page.keyboard.press("x");

    // Past the old two-name limit: a third and a fourth name open, and a name in hand switches back.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /PANW/ }).getByRole("button", { name: "Open PANW" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "PANW", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /XOM/ }).getByText("XOM", { exact: true }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "XOM", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(page.locator("body")).not.toContainText(/names practiced today|allows \d+ names/);
    await expect(page.getByRole("row", { name: /LRCX/ }).getByRole("button", { name: "Switch to LRCX" })).toHaveText("Switch"); // a name in hand switches back
    const dayPortfolio = await dayPagePortfolio(page);
    await expect(dayPortfolio.locator("li")).toHaveCount(4);
    await expect(dayPortfolio.getByTestId("portfolio-total")).toContainText(PRACTICE_COPY.dayPortfolioTotal);
    // Resume is the day's, never a name's: no per-name button says Resume, and the header resumes the whole day on its shared clock.
    await expect(page.getByRole("button", { name: /^Resume/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Resume Day \d+$/ })).toBeVisible();
    await expectCleanScreen(page);

    // The whole day ends together: every opened name scores.
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("a re-scan runs at the day clock, says when and on what data, and leaves the list as it was", async ({ page, context }) => {
    test.setTimeout(240_000);
    // The Desk recorded that morning with two of the stub's four names: the list scans those, and says so.
    await recordUniverse(context, [{ day: DAY, symbols: ["TSLA", "LRCX"] }]);
    await startEveryNamePlan(page, context);
    const dayUrl = page.url();
    const list = page.getByRole("table", { name: "Candidates" });
    await expect(list.getByRole("row", { name: /TSLA/ })).toBeVisible();
    await expect(list.getByRole("row", { name: /LRCX/ })).toBeVisible();
    await expect(list.getByRole("row", { name: /PANW|XOM/ })).toHaveCount(0);
    await expect(page.getByText(/the 2 symbols the Desk scanned that morning, as recorded/)).toBeVisible();

    // No name practiced yet, so no day clock: the button waits and says why.
    const rescan = page.getByRole("button", { name: PRACTICE_COPY.dayRescan });
    await expect(rescan).toBeDisabled();
    await expect(page.getByText(PRACTICE_COPY.dayRescanNeedsClock)).toBeVisible();

    // Practice TSLA five bars in (the clock reads 9:35), come back, and scan.
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    for (let bar = 0; bar < 5; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(rescan).toBeEnabled();
    await rescan.click();
    const label = page.getByTestId("rescan-label");
    await expect(label).toHaveText("Scan 1 · run at 9:35 AM ET · data through 9:20 AM");
    await expect(page.getByTestId("rescan-counts")).toHaveText("2 of 2 matched · 0 new since your list");
    await expect(label).not.toContainText("2026"); // dates stay hidden
    const scanned = page.getByRole("table", { name: "Re-scan" });
    await expect(scanned.getByRole("row", { name: /TSLA/ })).toBeVisible();
    await expect(scanned.getByRole("row", { name: /LRCX/ })).toBeVisible();
    await expect(list.getByRole("row")).toHaveCount(3); // the frozen list is unchanged: header and its two names
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);
    await expectCleanScreen(page);

    // The clock moves on: the old scan says it is older, and a new scan is its own.
    await page.getByRole("button", { name: "Switch to TSLA" }).first().click(); // the name in hand: its button reads Switch
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:37");
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await expect(page.getByTestId("rescan-stale")).toContainText("The day clock is now 9:37 AM ET · this scan is older");
    await rescan.click();
    await expect(label).toHaveText("Scan 2 · run at 9:37 AM ET · data through 9:22 AM");
    await expect(page.getByTestId("rescan-stale")).toHaveCount(0);

    // Ending the day closes scanning and keeps the last scan on screen.
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayRescan })).toHaveCount(0);
    await expect(label).toHaveText("Scan 2 · run at 9:37 AM ET · data through 9:22 AM");
    await expectCleanScreen(page);
  });

  test("the New plan modal starts on the first recorded morning once 20 finished days are recorded, and says why", async ({ page, context }) => {
    let dialog = await openNewPlan(page);
    let firstDay = dialog.locator('input[type="date"]');
    let note = dialog.getByTestId("first-day-note");

    // Nothing recorded yet: the usual start, three months back.
    await expect(note).toHaveText("The Desk has not recorded a morning's universe yet · the default start is three months back");
    await expect(firstDay).not.toHaveValue(DAY);

    // The Desk has recorded 20 finished days since Fri 2026-09-18 (the E2E clock is Thu 2026-10-15 after the close): a new plan
    // starts on it, unless she picks a day.
    await recordUniverse(context, [{ day: FIRST_RECORDED, symbols: ["TSLA"] }]);
    dialog = await openNewPlan(page);
    firstDay = dialog.locator('input[type="date"]');
    note = dialog.getByTestId("first-day-note");
    await expect(note).toHaveText("The first day the Desk recorded its universe · 20 finished days of it exist");
    await expect(firstDay).toHaveValue(FIRST_RECORDED);
    await firstDay.fill("2026-09-28");
    await expect(firstDay).toHaveValue("2026-09-28");
    await expectCleanScreen(page);
  });
});
