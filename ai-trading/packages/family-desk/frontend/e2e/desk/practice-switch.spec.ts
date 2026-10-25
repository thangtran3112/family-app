import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";

// Switching names on the shared day clock (02o-b2). The stub holds TSLA on Fri 2026-09-25, and three stand-in names that
// replay TSLA's day at a fraction of its prices (`replay/fixture.py`), so one daily list holds four names. Every session
// replays 09:30 to 09:40 ET at 1-minute bars; ArrowRight is one bar.

const DAY = "2026-09-25";
const SESSION_URL = /\/practice\/replay\?id=\d+/;
const DAY_URL = /\/practice\/day\?id=\d+/;

const playhead = (page: Page) => page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd");

/** The marks she has placed on the name on screen (the bottom panel is collapsed at 1180 until its tab opens). */
async function marks(page: Page) {
  await page.getByRole("tab", { name: "Marks" }).click();
  return page.getByRole("tabpanel");
}

/** The day's names: the left rail at 1440, the right drawer's "Names" tab at 1180. */
async function namesPanel(page: Page) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("region", { name: PRACTICE_COPY.dayNamesTitle });
  const drawer = page.getByRole("dialog", { name: "Names" });
  if (!(await drawer.isVisible())) await page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: "Names" }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** A filter that lists every name the stub has bars for, a thread, and a two-name plan saved through the hub form. */
async function startTwoNamePlan(page: Page, context: BrowserContext) {
  const all = {
    schemaVersion: 1,
    name: "Every name",
    watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
    liquidity: { minPrice: 1, minAvgVolume: 1 },
    when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
    maxResults: 50,
  };
  expect((await context.request.post(`${origin}/api/desk/screener/filters`, { data: { spec: all } })).ok()).toBeTruthy();
  await openDesk(page, "/practice");
  const threads = page.locator("#threads");
  await threads.getByRole("form", { name: "New thread" }).getByRole("button", { name: PRACTICE_COPY.threadSubmit }).click();
  await expect(threads.getByRole("article", { name: "Active practice thread" })).toContainText("$50,000");

  const daily = page.locator("#daily-list");
  await daily.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: "Every name" }).check();
  await daily.locator('input[type="date"]').fill(DAY);
  await daily.getByRole("group", { name: "Days" }).getByRole("button", { name: "5", exact: true }).click();
  await daily.getByLabel("To", { exact: true }).fill("09:40");
  await daily.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: "1m", exact: true }).click();
  // The plan's own limit on names: three is the default, this plan allows two.
  const names = daily.getByRole("group", { name: PRACTICE_COPY.planMaxSymbols });
  await expect(names.getByRole("button", { name: "3", exact: true })).toHaveAttribute("aria-pressed", "true");
  await names.getByRole("button", { name: "2", exact: true }).click();
  await daily.getByRole("button", { name: PRACTICE_COPY.planSubmit, exact: true }).click();
  await expect(daily.getByRole("button", { name: PRACTICE_COPY.planStart })).toBeVisible({ timeout: 60_000 });
  await daily.getByRole("button", { name: PRACTICE_COPY.planStart }).click();
  await page.waitForURL(DAY_URL);
}

test.describe("Practice: switching names", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a name opens at the day clock, a name left behind catches up, one trade is open at a time, and the plan's limit holds", async ({ page, context }) => {
    test.setTimeout(240_000);
    await startTwoNamePlan(page, context);
    const dayUrl = page.url();
    const table = page.getByRole("table", { name: "Candidates" });
    for (const symbol of ["TSLA", "LRCX", "PANW", "XOM"]) await expect(table.getByRole("row", { name: new RegExp(symbol) })).toBeVisible();

    // The plan's limit holds for stars: two names, and the third is refused in plain words.
    await page.getByRole("button", { name: "Star TSLA" }).click();
    await expect(page.getByRole("button", { name: "Unstar TSLA" })).toBeVisible(); // each star lands before the next click
    await page.getByRole("button", { name: "Star LRCX" }).click();
    await expect(page.getByRole("button", { name: "Unstar LRCX" })).toBeVisible();
    await page.getByRole("button", { name: "Star PANW" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Your plan limits a day to 2 names · unstar one first" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Star PANW" })).toBeVisible();
    await expect(page.getByTestId("names-today")).toHaveText("0 of 2 names practised today");
    await expectCleanScreen(page);

    // Practise TSLA three bars in, and take a trade.
    await page.getByRole("button", { name: "Practise TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    for (let bar = 0; bar < 3; bar += 1) await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:33");
    const tslaPlayhead = (await playhead(page).textContent()) ?? "";
    await page.keyboard.press("b");
    await expect(await marks(page)).toContainText("Practice long");

    // One open trade a day: the switch is refused in plain words while TSLA is open.
    let names = await namesPanel(page);
    await expect(names).toContainText("0 of 2 names".replace("0", "1"));
    await expect(names.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayOnNow);
    await names.getByRole("button", { name: "Switch to LRCX" }).click();
    await expect(names.getByRole("alert")).toContainText("Close your open TSLA practice trade before you switch to LRCX");
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await page.keyboard.press("x");
    await expect(await marks(page)).toContainText("Practice exit");

    // The switch opens LRCX at the clock TSLA reached, not at the window start.
    names = await namesPanel(page);
    await names.getByRole("button", { name: "Switch to LRCX" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "LRCX", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(tslaPlayhead);
    await expect(page.getByTestId("behind-clock")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toContainText("9:35");
    const clock = (await playhead(page).textContent()) ?? "";
    await expectCleanScreen(page);

    // TSLA stayed at 9:33 while the clock moved on: it is behind, says so, and cannot be marked until it catches up.
    names = await namesPanel(page);
    await expect(names.locator('[data-symbol="TSLA"]')).toContainText(PRACTICE_COPY.dayBehind);
    await expect(names).toContainText("2 of 2 names");
    await names.getByRole("button", { name: "Switch to TSLA" }).click();
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

    // The plan's limit holds for names too: a third name is a 409 in plain words, on the list screen.
    await page.getByRole("link", { name: PRACTICE_COPY.backToList }).click();
    await page.waitForURL(dayUrl);
    await page.getByRole("row", { name: /PANW/ }).getByRole("button", { name: "Practise PANW" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Your plan allows 2 names a day · you are on TSLA and LRCX" })).toBeVisible();
    await expect(page.getByTestId("names-today")).toHaveText("2 of 2 names practised today");
    await expect(page.getByRole("row", { name: /LRCX/ }).getByRole("button", { name: "Practise LRCX" })).toHaveText("Resume"); // a name in hand resumes
    await expectCleanScreen(page);

    // The whole day ends together: both names score.
    await page.getByRole("button", { name: PRACTICE_COPY.dayEnd, exact: true }).click();
    await page.getByRole("group", { name: "Confirm ending the day" }).getByRole("button", { name: PRACTICE_COPY.dayEnd }).click();
    await expect(page.getByRole("region", { name: PRACTICE_COPY.reviewTitle })).toBeVisible();
    await expectCleanScreen(page);
  });
});
