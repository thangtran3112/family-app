import { COPY } from "../../lib/desk/freshness.ts";
import { test, expect, prepareDesk, setScenario, openDesk, expectCleanScreen, MIDDAY } from "./helpers";

// The desktop shell (02m D1, D12; 02l §b2-b3, §c3): top bar, rails, status bar, states, errors and wrong-lane screens.
const PRE_MARKET = "2026-10-15T12:00:00Z";

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

// 5R: the View chips read as a switch, not two more nav tabs: Technical first, a visible caption, a tooltip that says what the chip switches to.
test("the View chips list Technical first, carry a caption and say where each one leads", async ({ page }) => {
  await openDesk(page, "/");
  const top = page.locator(".dk-top");
  const chips = top.getByRole("radiogroup", { name: "View" }).getByRole("radio");
  await expect(chips).toHaveText(["Technical", "Fundamental"]);
  await expect(top.getByText("View", { exact: true })).toBeVisible();
  await expect(chips.nth(0)).toHaveAttribute("title", "Day and swing practice, screener, alerts");
  await expect(chips.nth(1)).toHaveAttribute("title", "Holdings, covered calls, research");

  // On a Technical-only screen the other chip stays clickable and says what the switch leaves.
  await openDesk(page, "/practice");
  await expect(chips.nth(1)).toBeEnabled();
  await expect(chips.nth(1)).toHaveAttribute("title", "Leaves Practice · Technical-only screen");
  await expect(chips.nth(0)).toHaveAttribute("title", "Day and swing practice, screener, alerts");
  await chips.nth(1).focus();
  await expect(chips.nth(1)).toBeFocused();
});

// D-109 / S-06: the shell owns the page's one `main` landmark; a screen inside it is a plain div.
test("every route has exactly one main landmark, and it is the shell's content region", async ({ page }) => {
  for (const path of ["/", "/practice", "/screener", "/strategies", "/technicals", "/settings"]) {
    await openDesk(page, path);
    await expect(page.locator("main"), path).toHaveCount(1);
    await expect(page.locator("main#main-content"), path).toHaveCount(1);
  }
});

test("the top bar, left rail and status bar show the Technical chrome at the seed clock", async ({ page }) => {
  const compact = test.info().project.name === "desktop-1180";
  await openDesk(page, "/");
  const top = page.locator(".dk-top");
  await expect(top.getByRole("link", { name: "Family Desk" })).toHaveAttribute("href", "/");
  await expect(top.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Technical" })).toBeChecked();
  await expect(top.getByRole("navigation", { name: "Primary navigation" }).getByRole("link")).toHaveText(["Today", "Screener", "Watchlists", "Alerts", "Strategies", "Practice"]);
  // At 1180 the search collapses to an icon button that opens the field.
  if (compact) await expect(top.getByRole("button", { name: "Search symbols, ⌘K" })).toBeVisible();
  else await expect(top.getByRole("combobox", { name: "Search symbols" })).toBeVisible();
  await expect(top.getByTitle(/^Market closed · opens /)).toBeVisible();
  await expect(top.getByRole("status")).toHaveText(COPY.closed);
  await expect(top.getByRole("button", { name: "Alerts", exact: true })).toBeVisible();
  await expect(top.getByRole("button", { name: "Account menu" })).toBeVisible();

  const left = page.getByRole("complementary", { name: "Watchlists and filters" });
  await expect(left.getByRole("tab", { name: "Watchlists" })).toHaveAttribute("aria-selected", "true");
  await expect(left.getByRole("tab", { name: "Filters" })).toBeVisible();

  // No alert strategy has run yet, so the status bar says alerts start once quotes are connected.
  const footer = page.getByRole("contentinfo", { name: "Status" });
  await expect(footer).toContainText("Market closed");
  await expect(footer).toContainText(COPY.alertsNotStarted);
  await expectCleanScreen(page);
});

test("each primary nav link opens its route and keeps the top bar and left rail", async ({ page }) => {
  await openDesk(page, "/");
  const nav = page.locator(".dk-top").getByRole("navigation", { name: "Primary navigation" });
  const routes: Array<[label: string, path: string]> = [
    ["Screener", "/screener"],
    ["Watchlists", "/watchlists"],
    ["Alerts", "/alerts"],
    ["Strategies", "/strategies/library"],
    ["Practice", "/practice"],
    ["Today", "/"],
  ];
  for (const [label, path] of routes) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".dk-top")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Watchlists and filters" })).toBeVisible();
    await expectCleanScreen(page);
  }
});

test("each route has its own tab title, none scrolls sideways, and the top bar keeps its pill and badge whole", async ({ page }) => {
  const routes: Array<[path: string, title: string]> = [
    ["/", "Today"],
    ["/screener", "Screener"],
    ["/screener/filters", "Filter editor"],
    ["/technicals?symbol=NVDA#chart", "Technicals"],
    ["/watchlists", "Watchlists"],
    ["/alerts", "Alerts"],
    ["/alerts/new", "New alert"],
    ["/futures", "Futures"],
    ["/futures/specs", "Futures specs"],
    ["/settings", "Settings"],
  ];
  for (const [path, title] of routes) {
    await openDesk(page, path);
    await expect(page).toHaveTitle(`${title} - Family Desk`);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    // Only the search box gives way when the bar is full: no other top-bar element may clip its text.
    const clipped = await page.locator(".dk-top").evaluate((bar) =>
      [...bar.querySelectorAll<HTMLElement>("*")]
        .filter((el) => !(el instanceof HTMLInputElement) && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible")
        .map((el) => el.textContent),
    );
    expect(clipped, `${path} top bar clips`).toEqual([]);
  }
});

test("an open market with a delayed feed says so, and before the open the pill reads pre-market", async ({ page, context }) => {
  await setScenario(context, { now: MIDDAY, feedAgeMinutes: 5 });
  await openDesk(page, "/", MIDDAY);
  const top = page.locator(".dk-top");
  await expect(top.getByTitle("Market open", { exact: true })).toBeVisible();
  await expect(top.getByRole("status")).toHaveText(COPY.delayed);
  await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText(COPY.delayed);
  await expectCleanScreen(page);

  await setScenario(context, { now: PRE_MARKET, feedAgeMinutes: 5 });
  await openDesk(page, "/", PRE_MARKET);
  await expect(top.getByTitle("Pre-market", { exact: true })).toBeVisible();
  await expect(top.getByRole("status")).toContainText("Pre-market · ");
  await expectCleanScreen(page);
});

test("a feed silent for 90 minutes pauses quotes and, with alerts running, pauses alerts", async ({ page, context }) => {
  await prepareDesk(context, "technical-alerts");
  await setScenario(context, { now: MIDDAY, feedAgeMinutes: 90 });
  await openDesk(page, "/", MIDDAY);
  await expect(page.locator(".dk-top").getByRole("status")).toContainText("Quotes paused · last update ");
  await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText(COPY.alertsPaused);
  await expectCleanScreen(page);
});

test("a dropped quote stream reads Reconnecting and dims the last price, which stays on screen", async ({ page }) => {
  // Every quote connection fails, so the EventSource keeps retrying and the chart header stays in "reconnecting".
  await page.route("**/api/desk/quotes/**", (route) => route.abort());
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  const main = page.locator("#main-content");
  await expect(main.getByRole("status").filter({ hasText: COPY.reconnecting.replace(" {time}", "") })).toBeVisible();
  // The header's last price and the chart are the dimmed pair; the price is still on screen.
  const dimmed = main.locator("[data-dim='true']");
  await expect(dimmed).toHaveCount(2);
  await expect(dimmed.first()).toContainText(/\d+\.\d{2}/);
  await expectCleanScreen(page);
});

test("a failed chart request shows the load error and Try again draws the chart", async ({ page }) => {
  // Fail only the first bars request; unroute so the retry goes to the real API.
  await page.route("**/api/desk/bars/**", async (route) => {
    await route.abort();
    await page.unroute("**/api/desk/bars/**");
  });
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  const alert = page.locator("#main-content").getByRole("alert");
  await expect(alert).toContainText("Couldn't load this chart");
  await expectCleanScreen(page);

  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#main-content canvas").first()).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expectCleanScreen(page);
});

test("a Fundamental route shows the wrong-lane screen; Switch view and the lane radio move between lanes", async ({ page }) => {
  await openDesk(page, "/holdings");
  const main = page.locator("#main-content");
  const top = page.locator(".dk-top");
  await expect(main.getByRole("heading", { name: "This screen belongs to the Fundamental view" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Back to Today" })).toHaveAttribute("href", "/");
  await expectCleanScreen(page);

  await main.getByRole("button", { name: "Switch view" }).click();
  await expect(top.getByRole("radio", { name: "Fundamental" })).toBeChecked();
  await expect(top.getByRole("navigation", { name: "Primary navigation" }).getByRole("link")).toHaveText(["Today", "Holdings", "Covered calls", "Stocks", "Futures"]);
  await expect(main.getByTestId("fund-holdings")).toBeVisible();
  await expectCleanScreen(page);

  await top.getByRole("radio", { name: "Technical" }).click();
  await expect(top.getByRole("navigation", { name: "Primary navigation" }).getByRole("link")).toHaveText(["Today", "Screener", "Watchlists", "Alerts", "Strategies", "Practice"]);
  await expect(main.getByRole("heading", { name: "This screen belongs to the Fundamental view" })).toBeVisible();
  await main.getByRole("link", { name: "Back to Today" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(top.getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  await expectCleanScreen(page);
});

test("Ctrl+K focuses symbol search; typing NV and choosing NVDA opens its chart", async ({ page }) => {
  await openDesk(page, "/");
  await page.keyboard.press("Control+k");
  const search = page.locator(".dk-top").getByRole("combobox", { name: "Search symbols" });
  await expect(search).toBeFocused();
  await search.fill("NV");
  await page.getByRole("listbox", { name: "Matching symbols" }).getByRole("option", { name: /^NVDA\b/ }).click();
  await expect(page).toHaveURL(/\/technicals\?symbol=NVDA#chart$/);
  await expect(page.locator("#main-content").getByRole("heading", { name: "NVDA", level: 1 })).toBeVisible();
  await expectCleanScreen(page);
});

test("the chart's right rail: open at 1440, a collapsed strip with a drawer at 1180, and orders stay off", async ({ page }) => {
  const compact = test.info().project.name === "desktop-1180";
  await openDesk(page, "/technicals?symbol=NVDA#chart");
  if (compact) {
    await expect(page.getByRole("tablist", { name: "Symbol context" }).getByRole("tab")).toHaveText(["Summary", "Alerts", "Levels"]);
    await expect(page.getByRole("complementary", { name: "Symbol context" })).toHaveCount(0);
    await expect(page.getByText(COPY.ordersOff, { exact: true })).toHaveCount(0);
    const tab = page.getByRole("tab", { name: "Summary" });
    await expect(tab).toHaveAttribute("aria-expanded", "false");
    await expect(tab).toHaveAttribute("aria-controls", "rail-drawer");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-expanded", "true");
    const drawer = page.getByRole("dialog", { name: "Summary" });
    await expect(drawer).toHaveAttribute("id", "rail-drawer");
    await expect(drawer.getByText(COPY.ordersOff, { exact: true })).toBeVisible();
    await expectCleanScreen(page);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  } else {
    const rail = page.getByRole("complementary", { name: "Symbol context" });
    await expect(rail.getByRole("heading", { name: "Summary", level: 2 })).toBeVisible();
    await expect(rail.getByRole("heading", { name: "Alerts", level: 2 })).toBeVisible();
    await expect(rail.getByRole("heading", { name: "Levels", level: 2 })).toBeVisible();
    await expect(rail.getByText(COPY.ordersOff, { exact: true })).toBeVisible();
  }
  await expectCleanScreen(page);
});

// Fix wave 5S, stream 1: the top bar and the 404.
test("the search keeps its room beside two pills, the market pill drops the repeated prefix, and no top-bar control overflows (D-105, D-107)", async ({ page }) => {
  await openDesk(page, "/screener");
  const top = page.locator(".dk-top");
  const bar = await top.evaluate((node) => ({ over: node.scrollWidth > node.clientWidth + 1 }));
  expect(bar.over, "the bar does not overflow").toBe(false);
  if (test.info().project.name === "desktop-1440") {
    const search = (await top.getByRole("combobox", { name: "Search symbols" }).boundingBox())!;
    expect(search.width, "the box keeps room for its placeholder").toBeGreaterThanOrEqual(160);
    await expect(top.getByTitle(/^Market closed · opens /), "the pill keeps the whole text as its title").toBeVisible();
    await expect(top.getByTitle(/^Market closed · opens /)).not.toContainText("Market closed");
  }
});

test("a nav link's focus ring is drawn inside the bar, and the 404 links to Practice (D-108, D-135)", async ({ page }) => {
  await openDesk(page, "/screener");
  const link = page.locator(".dk-top").getByRole("navigation", { name: "Primary navigation" }).getByRole("link").first();
  await link.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS("outline-offset", "-2px");

  await page.goto("/journal?thread=2");
  await expect(page.getByRole("heading", { name: "This page does not exist", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Practice" })).toHaveAttribute("href", "/practice");
});
