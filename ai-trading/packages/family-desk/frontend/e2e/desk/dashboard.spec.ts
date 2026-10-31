import type { Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";
import { test, expect, prepareDesk, openDesk, expectCleanScreen, setScenario, watchApi, MIDDAY } from "./helpers";

// Today (02m D2): route `/` with the `/today` alias. Seeds: `technical` (market closed, no signals yet) and
// `technical-alerts` (four NVDA fires today, three unread, alerts running).

/** The 1180 band: the right rail is a tab strip and the alerts feed opens in a drawer (02m c1). */
const narrow = () => test.info().project.name === "desktop-1180";

/** The screen's own content (the status bar repeats some banner copy, so banner checks stay inside it). */
const main = (page: Page) => page.locator("#main-content");

/** The alerts feed: the 1440 right rail section, or the drawer the 1180 strip opens. */
async function alertsFeed(page: Page) {
  if (!narrow()) return page.getByRole("complementary", { name: "Alerts feed" });
  await page.getByRole("tab", { name: "Alerts" }).click();
  return page.getByRole("dialog", { name: "Alerts" });
}

test.describe("technical seed", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

  test("closed market: heading, strip with ETF links and unpriced IBKR futures, alerts-off banner", async ({ page }) => {
    await openDesk(page, "/");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    await expect(main(page).getByText(COPY.closed, { exact: true })).toBeVisible();
    const strip = page.getByRole("list", { name: "Market strip" });
    await expect(strip.getByRole("link", { name: /^SPY / })).toHaveAttribute("href", "/technicals?symbol=SPY#chart");
    await expect(strip.getByRole("link", { name: /^QQQ / })).toHaveAttribute("href", "/technicals?symbol=QQQ#chart");
    await expect(strip.getByRole("link", { name: /^IWM / })).toHaveAttribute("href", "/technicals?symbol=IWM#chart");
    // Futures are read-only: dashes and the not-connected note, never a price, and no link.
    for (const symbol of ["/ES", "/NQ"]) {
      await expect(strip.getByRole("listitem").filter({ hasText: symbol })).toHaveText(
        new RegExp(`^${symbol}\\s*—\\s*—\\s*${COPY.futuresNotConnected}$`),
      );
    }
    await expect(strip.getByRole("link")).toHaveCount(3);
    await expect(main(page).getByText(COPY.alertsNotStarted, { exact: true })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("no signals yet shows the empty-day line; the Abnormal volume card shows its count and links", async ({ page }) => {
    await openDesk(page, "/");
    const signals = page.locator("section").filter({ has: page.getByRole("heading", { name: "Today's signals" }) });
    await expect(signals.getByText(COPY.noSignalsToday, { exact: true })).toBeVisible();
    const card = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Abnormal volume" }) });
    await expect(card.getByRole("link", { name: "Abnormal volume" })).toHaveAttribute("href", "/screener?filter=1");
    await expect(card).toContainText("9 of 131");
    await expect(card.getByRole("link", { name: /^(BOLT|LKQ|SPTI)$/ })).toHaveCount(3);
    await expect(card.getByRole("link", { name: "BOLT" })).toHaveAttribute("href", "/technicals?symbol=BOLT#chart");
    await expectCleanScreen(page);
  });

  test("watchlist heat lists the Day movers with price and change, and events show MSFT earnings", async ({ page }) => {
    await openDesk(page, "/");
    const heat = page.getByRole("table", { name: "Watchlist heat" });
    await expect(heat.locator("tbody tr td:first-child")).toHaveText(["NVDA", "AMD", "TSLA", "PLTR", "META", "AAPL", "AVGO", "COIN"]);
    // Structure, not values: a price and a signed percentage on every row.
    await expect(heat.getByRole("row", { name: /^NVDA / })).toHaveText(/^NVDA\s*\d[\d,]*\.\d{2}\s*[+−-]\d+\.\d{2}%/);
    const events = page.locator("section").filter({ has: page.getByRole("heading", { name: "Upcoming events" }) });
    await expect(events.getByRole("listitem")).toHaveText(/MSFT\s*Wed 2026-10-28\s*Earnings · After close/);
    await expectCleanScreen(page);
  });

  test("Refresh asks the API for the dashboard again and the screen stays populated", async ({ page }) => {
    const api = watchApi(page); // attached before navigation so the first load is counted too
    const dashboardCalls = () => api.paths().filter((path) => path.startsWith("GET /api/desk/dashboard")).length;
    await openDesk(page, "/");
    const heat = page.getByRole("table", { name: "Watchlist heat" });
    await expect(heat.locator("tbody tr")).toHaveCount(8);
    const before = dashboardCalls();
    await Promise.all([
      page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/desk/dashboard"),
      page.getByRole("button", { name: "Refresh" }).click(),
    ]);
    expect(dashboardCalls()).toBeGreaterThan(before);
    await expect(heat.locator("tbody tr")).toHaveCount(8);
    await expect(page.getByText("Loading today…")).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("/today renders the same Today screen as /", async ({ page }) => {
    await openDesk(page, "/");
    await expect(page.getByRole("list", { name: "Market strip" })).toBeVisible();
    const home = await main(page).innerText();
    await openDesk(page, "/today");
    await expect(page.getByRole("list", { name: "Market strip" })).toBeVisible();
    expect(await main(page).innerText()).toBe(home);
    await expectCleanScreen(page);
  });

  test("the feed's age sets the freshness copy: 5 minutes reads Delayed 15 min, 90 minutes reads paused", async ({ page, context }) => {
    await setScenario(context, { now: MIDDAY, feedAgeMinutes: 5 });
    await openDesk(page, "/", MIDDAY);
    await expect(main(page).getByText(COPY.delayed, { exact: true })).toBeVisible();
    // The top-bar pill: full words at 1440, the session word at 1180 (full text in its title).
    await expect(page.getByTitle(COPY.marketOpen, { exact: true })).toHaveText(narrow() ? "Open" : COPY.marketOpen);
    await expectCleanScreen(page);

    await setScenario(context, { now: MIDDAY, feedAgeMinutes: 90 });
    await openDesk(page, "/", MIDDAY);
    await expect(main(page).getByText(/^Quotes paused · last update /)).toBeVisible();
    // V-Today-01: the page badge states the age the top bar does, and the prices carry a stale mark.
    const topBarAge = (await page.locator(".dk-top").getByRole("status").innerText()).trim();
    await expect(main(page).getByText(topBarAge, { exact: true })).toBeVisible();
    await expect(main(page).getByLabel("Market strip").getByText(/^Stale · /).first()).toBeVisible();
    await expectCleanScreen(page);
  });

  test("the watchlist heat drops vs VWAP and RVOL at 1180 and keeps both at 1440", async ({ page }) => {
    await openDesk(page, "/");
    const heat = page.getByRole("table", { name: "Watchlist heat" });
    await expect(heat.locator("tbody tr")).toHaveCount(8);
    await expect(heat.getByRole("columnheader")).toHaveText(
      narrow() ? ["Symbol", "Last", "Change %", "Bias"] : ["Symbol", "Last", "Change %", "RVOL", "vs VWAP", "Bias"],
    );
    await expectCleanScreen(page);
  });
});

test.describe("technical-alerts seed", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical-alerts"));

  test("today's signals list the four NVDA fires newest first, and a signal goes to the NVDA chart", async ({ page }) => {
    await openDesk(page, "/");
    const signals = page.locator("section").filter({ has: page.getByRole("heading", { name: "Today's signals" }) });
    await expect(signals.getByRole("listitem")).toHaveText([
      /^3:15 PM\s*NVDA\s*Hammer 15m near S1/,
      /^2:10 PM\s*NVDA\s*High-of-day break/,
      /^11:20 AM\s*NVDA\s*VWAP reclaim/,
      /^10:02 AM\s*NVDA\s*ORB 15m/,
    ]);
    await signals.getByRole("listitem").first().getByRole("link", { name: "NVDA" }).click();
    await expect(page).toHaveURL(/\/technicals\?symbol=NVDA#chart$/);
    await expect(page.getByRole("heading", { name: "NVDA", level: 1 })).toBeVisible();
  });

  test("alerts are running: no banner, and the bell and the alerts feed show 3 unread", async ({ page }) => {
    await openDesk(page, "/");
    await expect(page.getByRole("list", { name: "Market strip" })).toBeVisible();
    await expect(main(page).getByText(COPY.alertsNotStarted, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Alerts, 3 unread" })).toBeVisible();
    const feed = await alertsFeed(page);
    await expect(feed.getByText("Unread", { exact: true })).toHaveCount(3);
    await expectCleanScreen(page);
  });

  test("a feed paused for 90 minutes pauses the alerts banner", async ({ page, context }) => {
    await setScenario(context, { now: MIDDAY, feedAgeMinutes: 90 });
    await openDesk(page, "/", MIDDAY);
    await expect(main(page).getByText(COPY.alertsPaused, { exact: true })).toBeVisible();
    await expectCleanScreen(page);
  });
});
