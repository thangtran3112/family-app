import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { DAY_URL, openFirstDay, startThread } from "./hub-helpers";
import { createSwingThread } from "./swing-helpers";

// The practice thread's tab strip: Summary and Portfolio share /practice/thread (?tab=), Day list and Trades are routes
// that wear the same strip. A tab asks the server for the thread's open day, so it never sends her to a stale id. There is no Order
// tab or page: orders are placed on the chart, which opens only from a name she picked on the Day list or the Portfolio.

const SESSION_URL = /\/practice\/replay\?id=\d+/;
const strip = (page: Page) => page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel });
const tab = (page: Page, name: string) => strip(page).getByRole("tab", { name, exact: true });
const expectSelected = (page: Page, name: string) => expect(tab(page, name)).toHaveAttribute("aria-selected", "true");

test.describe("Practice thread tabs", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("Summary and Portfolio are one page: ?tab= picks the tab, Back and Forward walk them, a deep link opens Portfolio", async ({ page, context }) => {
    test.setTimeout(180_000);
    const id = await startThread(page, context);
    const summaryUrl = `/practice/thread?id=${id}`;

    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Day list", "Trades"]);
    await expectSelected(page, "Summary");
    await expect(page.getByRole("region", { name: "Thread balance" })).toBeVisible();

    await tab(page, "Portfolio").click();
    await expect(page).toHaveURL(`${summaryUrl}&tab=portfolio`);
    await expectSelected(page, "Portfolio");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText(PRACTICE_COPY.portfolioNoDay).or(panel.getByRole("region", { name: PRACTICE_COPY.dayPortfolio }))).toBeVisible();
    await expect(page.getByRole("region", { name: "Thread balance" }), "Summary's panels are not on the Portfolio tab").toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(summaryUrl); // the bare URL is Summary: no ?tab=summary is ever written
    await expectSelected(page, "Summary");
    await expect(page.getByRole("region", { name: "Thread balance" })).toBeVisible();
    await page.goForward();
    await expectSelected(page, "Portfolio");

    await openDesk(page, `${summaryUrl}&tab=portfolio`); // a cold load of the deep link
    await expectSelected(page, "Portfolio");
    await openDesk(page, `${summaryUrl}&tab=nonsense`);
    await expectSelected(page, "Summary");
  });

  test("the open day follows the thread across Day list, Trades and back; a chart opens only from a name she picked and selects no tab", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    const dayUrl = page.url();
    expect(dayUrl).toMatch(DAY_URL);

    // The day list wears the strip in the row the back link had.
    await expect(page.getByRole("link", { name: /Back to practice/ })).toHaveAttribute("href", "/practice");
    await expectSelected(page, "Day list");

    // Open a name: its chart wears the strip with no tab selected (orders are placed on the chart; it is no tab of the thread).
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(strip(page).getByRole("tab", { name: "Order" })).toHaveCount(0);
    await expect(strip(page).locator('[role="tab"][aria-selected="true"]')).toHaveCount(0);

    // The chart takes the whole window: the strip goes with the rest of the chrome, and comes back.
    await page.getByRole("button", { name: "Full screen" }).click();
    await expect(strip(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(strip(page)).toBeVisible();

    // Day list resolves to the same open day from anywhere, the chart included.
    await tab(page, "Day list").click();
    await page.waitForURL(dayUrl);
    await expectSelected(page, "Day list");

    await tab(page, "Trades").click();
    await page.waitForURL(`**/practice/journal?thread=${threadId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("thread ·");
    await expectSelected(page, "Trades");
    await expect(page.getByRole("region", { name: PRACTICE_COPY.fillsTitle, exact: true })).toContainText(PRACTICE_COPY.fillsEmpty); // a name is open, nothing is bought yet

    // The Portfolio tab of the thread page lists the name that was opened.
    await tab(page, "Portfolio").click();
    await page.waitForURL(`**/practice/thread?id=${threadId}&tab=portfolio`);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio })).toContainText("TSLA");
  });

  test("there is no Order tab and no /practice/order route, even for a thread with a started session", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL); // a session is started
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();

    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expectSelected(page, "Summary");
    await expect(page.getByRole("region", { name: "Thread balance" })).toBeVisible();
    await expect(strip(page).getByRole("tab", { name: "Order" })).toHaveCount(0);

    const response = await page.goto(`/practice/order?thread=${threadId}`);
    expect(response?.status(), "the retired route is not served").toBe(404);
  });

  // D-207: with no day open the Day list (Board) tab says why it cannot open, instead of a press that does nothing.
  async function expectNoDayReason(page: Page, name: string) {
    const target = tab(page, name);
    await expect(target).toHaveAttribute("aria-disabled", "true");
    await expect(target).toHaveAttribute("title", PRACTICE_COPY.tabNoDay);
    await expect(target, "the reason is the tab's accessible description").toHaveAccessibleDescription(PRACTICE_COPY.tabNoDay);
    await expect(target, "the reason is not part of the tab's name").toHaveAccessibleName(name);
    await target.click({ force: true }); // Playwright waits forever on an aria-disabled target otherwise
    await expectSelected(page, "Summary"); // a press is a no-op, not a silent navigation
  }

  test("a day thread with no day open: the Day list tab is described, and keyboard focus reaches it without selecting it", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await startThread(page, context);
    const summaryUrl = `/practice/thread?id=${threadId}`;
    await expectNoDayReason(page, "Day list");
    await expect(tab(page, "Portfolio")).not.toHaveAttribute("aria-disabled", "true");
    await tab(page, "Portfolio").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Day list")).toBeFocused();
    await expectSelected(page, "Summary"); // focus is reachable, selection is not
    await expect(page).not.toHaveURL(/\/practice\/day/);
    expect(page.url()).toContain(summaryUrl);
  });

  test("a swing thread's Day list tab is the Board; with no day open it is described, not silent", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context);
    const summaryUrl = `/practice/thread?id=${threadId}`;
    await openDesk(page, summaryUrl);
    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Board", "Trades"]);
    await expectNoDayReason(page, "Board");
    await expect(page).toHaveURL(summaryUrl);
    await tab(page, "Portfolio").click();
    await expect(page.getByRole("region", { name: "Open holds" }).getByText(PRACTICE_COPY.swingNoHoldsOpen)).toBeVisible();
  });
});
