import { expect, test } from "@playwright/test";
import { openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

test("390x844 mobile exposes five tabs, More routes, and no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDesk(page, "/more");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav.getByRole("link")).toHaveCount(5);
  for (const name of ["Watchlists", "Holdings", "Settings"]) {
    const link = page.getByRole("navigation", { name: "More pages" }).getByRole("link", { name: new RegExp(name) });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.goto("/more");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
