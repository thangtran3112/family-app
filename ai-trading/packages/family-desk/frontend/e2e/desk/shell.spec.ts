import { COPY } from "../../lib/desk/freshness.ts";
import { test, expect, prepareDesk, setScenario, openDesk, expectCleanScreen, expectBacktestChrome, MIDDAY } from "./helpers";

// The desktop shell (02m D1, D12; 02l §b2-b3, §c3; ADR-0014): top bar, mode menu, rails, status bar, states and errors.
const PRE_MARKET = "2026-10-15T12:00:00Z";

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

// ADR-0014: the mode button names the mode in full, right of the wordmark; its menu lists the three modes with what each holds and
// its shortcut. It replaces the 5R View chips: no radiogroup, no "View" caption.
test("the mode button names the mode in full and opens a three-item menu; a pick and Alt+1/2/3 switch modes", async ({ page }) => {
  await openDesk(page, "/");
  const top = page.locator(".dk-top");
  const nav = top.getByRole("navigation", { name: "Primary navigation" });
  const button = top.getByRole("button", { name: "Mode: Technical" });
  await expect(button).toHaveText("Technical");
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(top.getByRole("radiogroup", { name: "View" })).toHaveCount(0);
  await expect(top.getByText("View", { exact: true })).toHaveCount(0);

  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "Mode" });
  const items = menu.getByRole("menuitemradio");
  await expect(items).toHaveCount(3);
  const expected: Array<[string, string, string]> = [
    ["Technical", "Screener, watchlists, alerts, strategies", "/?mode=technical"],
    ["Fundamental", "Holdings, covered calls, research", "/?mode=fundamental"],
    ["Backtest", "Day and swing practice on past days, journal", "/practice"],
  ];
  for (const [index, [label, summary, href]] of expected.entries()) {
    await expect(items.nth(index)).toContainText(label);
    await expect(items.nth(index)).toContainText(summary);
    await expect(items.nth(index)).toContainText(`Alt ${index + 1}`);
    await expect(items.nth(index)).toHaveAttribute("href", href);
    await expect(items.nth(index)).toHaveAttribute("aria-checked", index === 0 ? "true" : "false");
  }
  // The checked mode takes focus; the arrows wrap; Escape closes and returns focus to the button.
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await expect(top.getByRole("button", { name: "Mode: Fundamental" })).toBeVisible();
  await expect(nav.getByRole("link")).toHaveText(["Today", "Holdings", "Covered calls", "Stocks", "Futures"]);
  await expectCleanScreen(page);

  await page.keyboard.press("Alt+3");
  await expect(page).toHaveURL(/\/practice$/);
  await expect(top.getByRole("button", { name: "Mode: Backtest" })).toBeVisible();
  await page.keyboard.press("Alt+1");
  await expect(page).toHaveURL(/\/$/);
  await expect(top.getByRole("button", { name: "Mode: Technical" })).toBeVisible();
  await expect(nav.getByRole("link")).toHaveText(["Today", "Screener", "Watchlists", "Alerts", "Strategies"]);
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
  await expect(top.getByRole("link", { name: "Family Desk" })).toHaveAttribute("href", "/?mode=technical");
  await expect(top.getByRole("button", { name: "Mode: Technical" })).toBeVisible();
  await expect(top.getByRole("navigation", { name: "Primary navigation" }).getByRole("link")).toHaveText(["Today", "Screener", "Watchlists", "Alerts", "Strategies"]);
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

// ADR-0014: the wrong-lane screen is gone. A route opens in the first mode that lists it, and the browser remembers that mode.
test("an owned route opens in its own mode with no wrong-lane screen, and shared routes keep the mode it set", async ({ page }) => {
  const main = page.locator("#main-content");
  const top = page.locator(".dk-top");
  const nav = top.getByRole("navigation", { name: "Primary navigation" });
  await openDesk(page, "/holdings");
  await expect(top.getByRole("button", { name: "Mode: Fundamental" })).toBeVisible();
  await expect(nav.getByRole("link")).toHaveText(["Today", "Holdings", "Covered calls", "Stocks", "Futures"]);
  await expect(nav.getByRole("link", { name: "Holdings" })).toHaveAttribute("aria-current", "page");
  await expect(main.getByTestId("fund-holdings")).toBeVisible();
  await expect(main.getByText("This screen belongs to", { exact: false })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Switch view" })).toHaveCount(0);
  await expectCleanScreen(page);

  await openDesk(page, "/watchlists");
  await expect(top.getByRole("button", { name: "Mode: Fundamental" })).toBeVisible();
  await openDesk(page, "/screener");
  await expect(top.getByRole("button", { name: "Mode: Technical" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Screener" })).toHaveAttribute("aria-current", "page");
  await openDesk(page, "/");
  await expect(top.getByRole("button", { name: "Mode: Technical" })).toBeVisible();
  await expectCleanScreen(page);
});

// ADR-0014: Backtest is the time-decoupled desk. It has the Practice and Journal tabs and no live-market chrome; Settings, More
// and Feedback stay one Account menu away.
test("Backtest mode: Practice and Journal tabs, no market pill, search or bell, its own status line, and the account pages", async ({ page }) => {
  const top = page.locator(".dk-top");
  const nav = top.getByRole("navigation", { name: "Primary navigation" });
  await openDesk(page, "/practice");
  await expectBacktestChrome(page, "Practice");
  await expect(top.getByRole("link", { name: "Family Desk" })).toHaveAttribute("href", "/practice");
  await expect(top.getByRole("button", { name: "Account menu" })).toBeVisible();
  await expect(top.getByRole("status")).toHaveCount(0);
  const left = page.getByRole("complementary", { name: "Watchlists", exact: true });
  await expect(left.getByRole("tab")).toHaveText(["Watchlists"]);
  const footer = page.getByRole("contentinfo", { name: "Status" });
  await expect(footer).toContainText("Practice · past market data");
  await expect(footer).not.toContainText("Market closed");
  await expect(footer).not.toContainText(COPY.alertsNotStarted);
  await expectCleanScreen(page);

  // Only the longest matching tab lights: the journal is Journal, not Practice.
  await nav.getByRole("link", { name: "Journal" }).click();
  await expect(page).toHaveURL(/\/practice\/journal$/);
  await expectBacktestChrome(page, "Journal");

  for (const [label, path] of [["Settings", "/settings"], ["More", "/more"], ["Feedback", "/feedback"]] as const) {
    await top.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(top.getByRole("button", { name: "Mode: Backtest" })).toBeVisible();
    await expect(page.locator("#main-content").getByText("This screen belongs to", { exact: false })).toHaveCount(0);
  }
  await expectCleanScreen(page);

  // Today has no Backtest variant: it sends the mode home.
  await openDesk(page, "/");
  await expect(page).toHaveURL(/\/practice$/);
  await expectBacktestChrome(page, "Practice");
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

// D-093: after a client-side route change the keyboard starts at the new page, not at the skip link and the chrome.
test("a route change moves focus to the page heading, not the search box it started from (D-093)", async ({ page }) => {
  await openDesk(page, "/");
  await page.keyboard.press("Control+k");
  await page.locator(".dk-top").getByRole("combobox", { name: "Search symbols" }).fill("NV");
  await page.getByRole("listbox", { name: "Matching symbols" }).getByRole("option", { name: /^NVDA\b/ }).click();
  await expect(page).toHaveURL(/\/technicals\?symbol=NVDA#chart$/);
  const main = page.locator("#main-content");
  await expect(main.getByRole("heading", { name: "NVDA", level: 1 })).toBeVisible();
  const where = await page.evaluate(() => {
    const active = document.activeElement;
    return { inMain: !!active?.closest("#main-content"), tag: active?.tagName, onBody: active === document.body };
  });
  expect(where, "focus is inside the page, never on the body or the search box").toMatchObject({ inMain: true, onBody: false });
});

test("when the focused control leaves the page, focus goes to the page heading, not the body (D-093)", async ({ page }) => {
  await openDesk(page, "/screener");
  const main = page.locator("#main-content");
  await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
  // A control that is replaced by another (Buy becomes Next day): focus it, then remove it.
  await main.evaluate((node) => {
    const gone = document.createElement("button");
    gone.id = "e2e-gone";
    gone.textContent = "Soon gone";
    node.append(gone);
    gone.focus();
  });
  await expect(page.locator("#e2e-gone")).toBeFocused();
  await page.locator("#e2e-gone").evaluate((node) => node.remove());
  await expect(main.getByRole("heading", { level: 1 })).toBeFocused();
});

test("a removed control never pulls focus off the search box (D-093)", async ({ page }) => {
  await openDesk(page, "/screener");
  const main = page.locator("#main-content");
  await main.evaluate((node) => {
    const gone = document.createElement("button");
    gone.id = "e2e-gone";
    node.append(gone);
    gone.focus();
  });
  const search = page.locator(".dk-top").getByRole("combobox", { name: "Search symbols" });
  await search.focus();
  await page.locator("#e2e-gone").evaluate((node) => node.remove());
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(search).toBeFocused();
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

test("the unread count sits above the bell, never on the glyph, even as 9+ (D-106)", async ({ page }) => {
  await page.route("**/api/desk/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.alerts.unread = 12;
    await route.fulfill({ response, json: body });
  });
  await openDesk(page, "/screener");
  const bell = page.locator(".dk-top").getByRole("button", { name: "Alerts, 12 unread" });
  await expect(bell).toBeVisible();
  const rects = await bell.evaluate((button) => {
    const box = (node: Element | null) => node!.getBoundingClientRect().toJSON() as { top: number; bottom: number; left: number; right: number };
    return { icon: box(button.querySelector("svg")), badge: box(button.querySelector("span")), button: box(button) };
  });
  expect(await bell.locator("span").textContent(), "twelve unread read as 9+").toBe("9+");
  // The bell is drawn 1.5 px inside its icon box, so the badge may dip that far and no further.
  expect(rects.badge.bottom, "the count clears the glyph").toBeLessThanOrEqual(rects.icon.top + 1.5);
  expect(rects.badge.top, "the count stays inside the viewport").toBeGreaterThanOrEqual(0);
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
