import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test, watchApi } from "./helpers";
import { DAY_URL, openFirstDay, startThread } from "./hub-helpers";
import { createSwingThread } from "./swing-helpers";

// The practice thread's tab strip: Summary and Portfolio share /practice/thread (?tab=), Day list, Order and Trades are routes
// that wear the same strip. A tab asks the server for the thread's open day, so it never sends her to a stale id. Order is the
// thread's own "pick a stock" page: a chart opens only from a name she picked on the Day list or the Portfolio.

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

    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Day list", "Order", "Trades"]);
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

  test("the open day follows the thread across Day list, Order, Trades and back; a chart opens only from a name she picked", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    const dayUrl = page.url();
    expect(dayUrl).toMatch(DAY_URL);
    const orderUrl = `**/practice/order?thread=${threadId}`;

    // The day list wears the strip in the row the back link had. Order is the thread's own page: it opens no chart of a name she did not pick.
    await expect(page.getByRole("link", { name: /Back to practice/ })).toHaveAttribute("href", "/practice");
    await expectSelected(page, "Day list");
    await tab(page, "Order").click();
    await page.waitForURL(orderUrl);
    await expectSelected(page, "Order");
    await tab(page, "Day list").click();
    await page.waitForURL(dayUrl);
    await expectSelected(page, "Day list");

    // Open a name: its chart wears the Order tab.
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expectSelected(page, "Order");

    // The chart takes the whole window: the strip goes with the rest of the chrome, and comes back.
    await page.getByRole("button", { name: "Full screen" }).click();
    await expect(strip(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(strip(page)).toBeVisible();

    // Day list resolves to the same open day from anywhere.
    await tab(page, "Day list").click();
    await page.waitForURL(dayUrl);
    await expectSelected(page, "Day list");

    await tab(page, "Trades").click();
    await page.waitForURL(`**/practice/journal?thread=${threadId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("thread ·");
    await expectSelected(page, "Trades");
    await expect(page.getByRole("region", { name: PRACTICE_COPY.fillsTitle, exact: true })).toContainText(PRACTICE_COPY.fillsEmpty); // a name is open, nothing is bought yet

    // The Portfolio tab of the thread page lists the name that was opened; Order from there is still the "pick a stock" page.
    await tab(page, "Portfolio").click();
    await page.waitForURL(`**/practice/thread?id=${threadId}&tab=portfolio`);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.dayPortfolio })).toContainText("TSLA");
    await tab(page, "Order").click();
    await page.waitForURL(orderUrl);
    await expect(page.getByText(PRACTICE_COPY.orderPickTitle)).toBeVisible();
  });

  test("Order asks for a stock: from the Summary of a thread with a started session it opens no chart and requests no session", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(SESSION_URL); // a session is started: the old Trade tab would have reopened its chart
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();

    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expectSelected(page, "Summary");
    const api = watchApi(page);
    await expect(page.getByRole("region", { name: "Thread balance" })).toBeVisible(); // the Summary has loaded; only what the click asks for counts
    api.clear();
    await tab(page, "Order").click();
    await page.waitForURL(`**/practice/order?thread=${threadId}`);
    await expectSelected(page, "Order");
    await expect(page.getByText(PRACTICE_COPY.orderPickTitle)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the Day list" })).toHaveAttribute("href", /\/practice\/day\?id=\d+$/);
    // The names of the open day are right here: the opened one says so, and a click opens a chart.
    const names = page.getByRole("table", { name: PRACTICE_COPY.orderNames });
    await expect(names.getByRole("row", { name: /TSLA/ })).toContainText(PRACTICE_COPY.orderStatusOpened);
    await page.getByLabel(PRACTICE_COPY.orderFind).fill("zzzz");
    await expect(page.getByText(PRACTICE_COPY.orderFindNone)).toBeVisible();
    await page.getByLabel(PRACTICE_COPY.orderFind).fill("tsla");
    await expect(page.getByRole("link", { name: PRACTICE_COPY.orderOpenPortfolio })).toHaveAttribute("href", `/practice/thread?id=${threadId}&tab=portfolio`);
    await expect(page.getByTestId("chart-slot")).toHaveCount(0);
    expect(api.paths().filter((path) => path.includes("/replay/sessions/")), "no session is requested").toEqual([]);

    await page.getByRole("button", { name: "Open TSLA" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  });

  test("a swing thread's Day list tab is the Board; with no day open Board lands on Summary and Order says to start the day there", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context);
    const summaryUrl = `/practice/thread?id=${threadId}`;
    await openDesk(page, summaryUrl);
    await expect(strip(page).getByRole("tab")).toHaveText(["Summary", "Portfolio", "Board", "Order", "Trades"]);
    await tab(page, "Board").click();
    await expect(page).toHaveURL(summaryUrl);
    await expectSelected(page, "Summary");
    await tab(page, "Order").click();
    await expect(page).toHaveURL(`/practice/order?thread=${threadId}`);
    await expectSelected(page, "Order");
    await expect(page.getByText(PRACTICE_COPY.orderNoDayBody)).toBeVisible();
    await tab(page, "Portfolio").click();
    await expect(page.getByRole("region", { name: "Open holds" }).getByText(PRACTICE_COPY.swingNoHoldsOpen)).toBeVisible();
  });
});
