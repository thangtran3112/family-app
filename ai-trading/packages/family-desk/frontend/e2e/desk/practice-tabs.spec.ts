import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { REPLAY_URL, SCREEN_URL, createThreadByApi, expectNoDayLanguage, scanByApi } from "./hub-helpers";

// The practice thread's tab strip: Summary and Portfolio share /practice/thread (?tab=), Screen and Trades are routes that wear the same strip. A
// freestyle thread has one Screen and one journal, so every tab is a fixed address and none asks the server where it goes (ADR-0025). There is no
// Order tab: orders are placed on the chart, which opens only from a name she picked on the Screen or the Portfolio.

const strip = (page: Page) => page.getByRole("tablist", { name: PRACTICE_COPY.tabsLabel });
const tab = (page: Page, name: string) => strip(page).getByRole("tab", { name, exact: true });
const expectSelected = (page: Page, name: string) => expect(tab(page, name)).toHaveAttribute("aria-selected", "true");

test.describe("Practice thread tabs", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("Summary and Portfolio are one page: ?tab= picks the tab, Back and Forward walk them, a deep link opens Portfolio", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    const summaryUrl = `/practice/thread?id=${id}`;
    await openDesk(page, summaryUrl);

    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Screen", "Trades"]);
    await expectSelected(page, "Summary");
    await expect(page.getByRole("region", { name: "Thread balance" })).toBeVisible();

    await tab(page, "Portfolio").click();
    await expect(page).toHaveURL(`${summaryUrl}&tab=portfolio`);
    await expectSelected(page, "Portfolio");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("region", { name: PRACTICE_COPY.portfolioTitle })).toBeVisible();
    await expect(panel.getByText(PRACTICE_COPY.portfolioEmpty)).toBeVisible(); // nothing is held yet: open positions only
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
    await openDesk(page, `${summaryUrl}&tab=screen`); // Screen is a route, not a ?tab= of the thread page
    await expectSelected(page, "Summary");
  });

  test("the Screen and Trades tabs are fixed addresses of the thread, from any tab and from a chart; a chart opens only from a name she picked and selects no tab", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await createThreadByApi(context);
    await scanByApi(context, threadId);
    await openDesk(page, `/practice/thread?id=${threadId}`);

    await tab(page, "Screen").click();
    await page.waitForURL(`**/practice/screen?thread=${threadId}`);
    await expectSelected(page, "Screen");
    // The Screen wears the strip in the row the back link had.
    await expect(page.getByRole("link", { name: /Back to practice/ })).toHaveAttribute("href", "/practice");

    // Open a name: its chart wears the strip with no tab selected (orders are placed on the chart; it is no tab of the thread).
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(strip(page).getByRole("tab", { name: "Order" })).toHaveCount(0);
    await expect(strip(page).locator('[role="tab"][aria-selected="true"]')).toHaveCount(0);

    // The chart takes the whole window: the strip goes with the rest of the chrome, and comes back.
    await page.getByRole("button", { name: "Full screen" }).click();
    await expect(strip(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(strip(page)).toBeVisible();

    // Screen is the same address from anywhere, the chart included: the thread has one Screen.
    await tab(page, "Screen").click();
    await page.waitForURL(`**/practice/screen?thread=${threadId}`);
    await expectSelected(page, "Screen");
    await expect(page.getByRole("region", { name: PRACTICE_COPY.screenLanes })).toContainText("TSLA"); // the name she opened is a lane of the thread

    await tab(page, "Trades").click();
    await page.waitForURL(`**/practice/journal?thread=${threadId}`);
    await expectSelected(page, "Trades");
    await expect(page.getByRole("region", { name: PRACTICE_COPY.fillsTitle, exact: true })).toContainText(PRACTICE_COPY.fillsEmpty); // a name is open, nothing is bought yet

    // The Portfolio tab holds open positions only: an opened name with nothing bought is not a row.
    await tab(page, "Portfolio").click();
    await page.waitForURL(`**/practice/thread?id=${threadId}&tab=portfolio`);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle })).toContainText(PRACTICE_COPY.portfolioEmpty);
    await expectNoDayLanguage(page);
  });

  test("no tab is ever disabled or asks the server: a thread that has not been scanned still opens its Screen, which says so", async ({ page, context }) => {
    const threadId = await createThreadByApi(context);
    await openDesk(page, `/practice/thread?id=${threadId}`);
    for (const name of ["Summary", "Portfolio", "Screen", "Trades"]) await expect(tab(page, name)).not.toHaveAttribute("aria-disabled", "true");
    await tab(page, "Screen").click();
    await page.waitForURL(SCREEN_URL);
    await expectSelected(page, "Screen");
    await expect(page.getByTestId("not-scanned")).toBeVisible(); // a new Screen is empty until its first scan
  });

  test("there is no Order tab and no /practice/order route, even for a thread with an open lane", async ({ page, context }) => {
    const threadId = await createThreadByApi(context);
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expectSelected(page, "Summary");
    await expect(page.getByRole("region", { name: "Thread balance" })).toBeVisible();
    await expect(strip(page).getByRole("tab", { name: "Order" })).toHaveCount(0);

    const response = await page.goto(`/practice/order?thread=${threadId}`);
    expect(response?.status(), "the retired route is not served").toBe(404);
  });
});
