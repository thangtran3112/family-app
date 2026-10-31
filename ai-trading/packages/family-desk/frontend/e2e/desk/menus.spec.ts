import { test, expect, prepareDesk, openDesk } from "./helpers";

// ui/Menu and ui/Popover (DS-1): one keyboard contract for the top bar's three popups. The mode menu's own wiring (Alt+1/2/3,
// summaries, a full page load) is in shell.spec.ts; this file holds what the primitives promise every consumer.

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

// A point in the centre pane well below every popup (the mode menu hangs near the pane's top-left corner).
const OUTSIDE = { position: { x: 200, y: 400 } };

test("the account menu is a ui/Menu: ArrowDown on the button opens it on the first item; arrows wrap; Home and End jump; Escape returns focus", async ({ page }) => {
  await openDesk(page, "/");
  const button = page.locator(".dk-top").getByRole("button", { name: "Account menu" });
  const menu = page.getByRole("menu", { name: "Account" });
  const items = menu.getByRole("menuitem");

  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const last = (await items.count()) - 1;
  expect(last).toBeGreaterThan(0);
  await expect(items.first()).toBeFocused();
  // A plain link menu has no selection, so nothing is checked.
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);

  await page.keyboard.press("ArrowUp");
  await expect(items.nth(last)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(last)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toBeFocused();
});

test("a press outside closes the account menu and leaves focus where the press put it", async ({ page }) => {
  await openDesk(page, "/");
  const top = page.locator(".dk-top");
  const button = top.getByRole("button", { name: "Account menu" });
  await button.click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu).toBeVisible();
  await page.locator("#main-content").click(OUTSIDE);
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).not.toBeFocused();
  // A second press on the button opens it again (a press on the anchor is not "outside").
  await button.click();
  await expect(menu).toBeVisible();
  await button.click();
  await expect(menu).toHaveCount(0);
});

test("the mode menu marks the current mode checked, and a press outside closes it", async ({ page }) => {
  await openDesk(page, "/");
  const button = page.locator(".dk-top").getByRole("button", { name: "Mode: Technical" });
  await button.click();
  const menu = page.getByRole("menu", { name: "Mode" });
  const items = menu.getByRole("menuitemradio");
  await expect(items).toHaveCount(3);
  await expect(menu.locator('[aria-checked="true"]')).toHaveCount(1);
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(items.nth(1)).toHaveAttribute("aria-checked", "false");
  await expect(items.nth(2)).toHaveAttribute("aria-checked", "false");
  await page.locator("#main-content").click(OUTSIDE);
  await expect(menu).toHaveCount(0);

  // The checked item follows the mode: opening it in Fundamental puts focus on Fundamental.
  await page.keyboard.press("Alt+2");
  const fundamental = page.locator(".dk-top").getByRole("button", { name: "Mode: Fundamental" });
  await expect(fundamental).toBeVisible();
  await fundamental.click();
  const reopened = page.getByRole("menu", { name: "Mode" }).getByRole("menuitemradio");
  await expect(reopened.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(reopened.nth(1)).toBeFocused();
});

test("the alerts bell is a ui/Popover dialog: it opens without moving focus, Tab reaches its controls, Escape closes and returns focus", async ({ page }) => {
  await openDesk(page, "/");
  const bell = page.locator(".dk-top").getByRole("button", { name: "Alerts", exact: true });
  await expect(bell).toHaveAttribute("aria-haspopup", "dialog");
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("dialog", { name: "Recent alerts" });
  await expect(panel).toBeVisible();
  await expect(bell).toBeFocused();

  // The panel sits right after the button in tab order: the seed has no alerts, so the footer holds the two controls.
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Mark all read" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("link", { name: "View alerts" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await expect(bell).toBeFocused();

  await bell.click();
  await expect(panel).toBeVisible();
  await page.locator("#main-content").click(OUTSIDE);
  await expect(panel).toHaveCount(0);
});
