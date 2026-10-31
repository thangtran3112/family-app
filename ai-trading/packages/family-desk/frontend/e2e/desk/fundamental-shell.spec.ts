import { COPY } from "../../lib/desk/freshness.ts";
import { test, expect, prepareDesk, openDesk, expectCleanScreen, origin } from "./helpers";
import { startInFundamental, watchGated } from "./fundamental-helpers";

// The Fundamental lane's shell (02n §b1): lane switch, nav, left rail, masking switch, shared routes and the reading-only futures page.
test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

const nav = (page: import("@playwright/test").Page) => page.locator(".dk-top").getByRole("navigation", { name: "Primary navigation" });

test("the lane switch turns the shell Fundamental: its nav, its left rail and the masking switch", async ({ page }) => {
  const gated = watchGated(page);
  await openDesk(page, "/");
  const top = page.locator(".dk-top");
  await expect(top.getByTestId("mask-toggle")).toHaveCount(0);
  await top.getByRole("radio", { name: "Fundamental" }).click();
  await expect(top.getByRole("radio", { name: "Fundamental" })).toBeChecked();
  await expect(nav(page).getByRole("link")).toHaveText(["Today", "Holdings", "Covered calls", "Stocks", "Futures"]);
  await expect(nav(page).getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  const left = page.getByRole("complementary", { name: "Holdings and watchlists" });
  await expect(left.getByRole("tab")).toHaveText(["Holdings", "Watchlists"]);
  await expect(left.getByRole("tab", { name: "Holdings" })).toHaveAttribute("aria-selected", "true");
  await left.getByRole("tab", { name: "Watchlists" }).click();
  await expect(left.getByRole("tab", { name: "Watchlists" })).toHaveAttribute("aria-selected", "true");
  await expect(top.getByTestId("mask-toggle")).toBeVisible();
  await expectCleanScreen(page);
  // Back to Technical: the Technical chrome returns.
  await top.getByRole("radio", { name: "Technical" }).click();
  await expect(nav(page).getByRole("link")).toHaveText(["Today", "Screener", "Watchlists", "Alerts", "Strategies", "Practice"]);
  await expect(top.getByTestId("mask-toggle")).toHaveCount(0);
  expect(gated()).toEqual([]);
});

test("values are hidden on every load; the switch and Alt+M show and hide them", async ({ page }) => {
  await startInFundamental(page);
  await openDesk(page, "/");
  const toggle = page.getByTestId("mask-toggle");
  await expect(toggle).toHaveText(COPY.maskShow);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveText(COPY.maskHide);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+m");
  await expect(toggle).toHaveText(COPY.maskShow);
  // The switch does not persist: a reload hides again.
  await toggle.click();
  await page.reload();
  await expect(page.getByTestId("mask-toggle")).toHaveText(COPY.maskShow);
  await expectCleanScreen(page);
});

test("the saved settings choose the first view and the masking default on a browser with no lane of its own", async ({ page }) => {
  const saved = await page.request.put(`${origin}/api/desk/settings`, { data: { settings: { default_view: "fundamental", mask_values: false } } });
  expect(saved.ok()).toBeTruthy();
  await openDesk(page, "/");
  await expect(page.locator(".dk-top").getByRole("radio", { name: "Fundamental" })).toBeChecked();
  await expect(page.getByTestId("mask-toggle")).toHaveText(COPY.maskHide);
  await expectCleanScreen(page);
});

test("shared routes render in the Fundamental lane with no interstitial; Technical-only routes keep it", async ({ page }) => {
  await startInFundamental(page);
  for (const path of ["/", "/today", "/watchlists", "/settings", "/more", "/futures/specs"]) {
    await openDesk(page, path);
    await expect(page.locator("#main-content").getByText("This screen belongs to", { exact: false })).toHaveCount(0);
  }
  for (const path of ["/screener", "/alerts", "/futures"]) {
    await openDesk(page, path);
    await expect(page.locator("#main-content").getByRole("heading", { name: "This screen belongs to the Technical view" })).toBeVisible();
  }
  await expectCleanScreen(page);
});

test("Futures is reading only: roll dates are real, prices say they are not connected, and nothing asks for the gated readings", async ({ page }) => {
  const gated = watchGated(page);
  await startInFundamental(page);
  await openDesk(page, "/futures/read");
  const main = page.locator("#main-content");
  await expect(main.getByTestId("futures-reading-only")).toContainText(COPY.futuresReadingOnly);
  await expect(main.getByTestId("futures-deferred")).toHaveText(COPY.futuresDeferred);
  const table = main.getByRole("table", { name: "Futures reading" });
  for (const root of ["/ES", "/NQ", "/CL", "/GC"]) await expect(table.getByRole("row", { name: new RegExp(`^${root}\\b`) })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Futures", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("link", { name: "Contract sizes and roll calendar" })).toHaveAttribute("href", "/futures/specs");
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expectCleanScreen(page);

  await main.getByRole("link", { name: "Switch to Technical" }).click();
  await expect(page).toHaveURL(/\/futures$/);
  await expect(page.locator(".dk-top").getByRole("radio", { name: "Technical" })).toBeChecked();
  expect(gated()).toEqual([]);
});

test("each Fundamental tab opens its route and keeps the Fundamental chrome", async ({ page }) => {
  await startInFundamental(page);
  await openDesk(page, "/");
  const routes: Array<[label: string, path: RegExp, testid: string]> = [
    ["Holdings", /\/holdings$/, "fund-holdings"],
    ["Covered calls", /\/covered-calls$/, "fund-cc"],
    ["Stocks", /\/stocks$/, "fund-stocks"],
    ["Futures", /\/futures\/read$/, ""],
    ["Today", /\/$/, "fund-today"],
  ];
  for (const [label, path, testid] of routes) {
    await nav(page).getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(path);
    await expect(nav(page).getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    if (testid) await expect(page.locator("#main-content").getByTestId(testid)).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Holdings and watchlists" })).toBeVisible();
    await expectCleanScreen(page);
  }
});

test("the futures specs page is shared, and its way back stays in the active lane", async ({ page }) => {
  await startInFundamental(page);
  await openDesk(page, "/futures/specs");
  const back = page.locator("#main-content").getByRole("link", { name: "Back to futures", exact: true });
  await expect(back).toHaveAttribute("href", "/futures/read");
  await back.click();
  await expect(page).toHaveURL(/\/futures\/read$/);
  await expect(page.locator("#main-content").getByRole("heading", { name: "This screen belongs to the Technical view" })).toHaveCount(0);
  await expect(page.locator("#main-content").getByTestId("futures-reading-only")).toBeVisible();
  // The Technical view keeps its own swing screen as the way back.
  await page.locator(".dk-top").getByRole("radio", { name: "Technical" }).click();
  await openDesk(page, "/futures/specs");
  await expect(page.locator("#main-content").getByRole("link", { name: "Back to futures swing" })).toHaveAttribute("href", "/futures");
});
