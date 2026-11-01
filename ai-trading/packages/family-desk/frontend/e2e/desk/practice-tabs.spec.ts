import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { DAY_URL, openFirstDay, startThread } from "./hub-helpers";
import { createSwingThread } from "./swing-helpers";

// The practice thread's tab strip: Summary and Portfolio share /practice/thread (?tab=), Day list, Trade and Journal are routes
// that wear the same strip. A tab asks the server for the thread's open day and session, so it never sends her to a stale id.

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

    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Day list", "Trade", "Journal"]);
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

  test("the open day and its session follow the thread across Day list, Trade, Journal and back", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    const dayUrl = page.url();
    expect(dayUrl).toMatch(DAY_URL);

    // The day list wears the strip in the row the back link had; Trade with no session yet stays on the day list.
    await expect(page.getByRole("link", { name: /Back to practice/ })).toHaveAttribute("href", "/practice");
    await expectSelected(page, "Day list");
    await tab(page, "Trade").click();
    await expect(page).toHaveURL(dayUrl);
    await expectSelected(page, "Day list");

    // Open a name: the replay is the Trade tab.
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expectSelected(page, "Trade");
    const replayUrl = page.url();

    // Day list and Trade resolve to the same open day and session from anywhere.
    await tab(page, "Day list").click();
    await page.waitForURL(dayUrl);
    await expectSelected(page, "Day list");
    await tab(page, "Trade").click();
    await page.waitForURL(replayUrl);
    await expectSelected(page, "Trade");

    // The chart takes the whole window: the strip goes with the rest of the chrome, and comes back.
    await page.keyboard.press("f");
    await expect(strip(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(strip(page)).toBeVisible();

    await tab(page, "Journal").click();
    await page.waitForURL(`**/practice/journal?thread=${threadId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Thread ·");
    await expectSelected(page, "Journal");

    // The Portfolio tab of the thread page lists the name that was opened.
    await tab(page, "Portfolio").click();
    await page.waitForURL(`**/practice/thread?id=${threadId}&tab=portfolio`);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio })).toContainText("TSLA");
    await tab(page, "Trade").click();
    await page.waitForURL(replayUrl);
  });

  test("a swing thread's Day list tab is the Board; with no day open Board and Trade land on Summary", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context);
    const summaryUrl = `/practice/thread?id=${threadId}`;
    await openDesk(page, summaryUrl);
    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Board", "Trade", "Journal"]);
    await tab(page, "Board").click();
    await expect(page).toHaveURL(summaryUrl);
    await expectSelected(page, "Summary");
    await tab(page, "Portfolio").click();
    await expect(page.getByRole("region", { name: "Open holds" }).getByText(PRACTICE_COPY.swingNoHoldsOpen)).toBeVisible();
  });
});
