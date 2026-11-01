import type { Locator, Page } from "@playwright/test";
import { test, expect, prepareDesk, openDesk } from "./helpers";

// ui/Dialog, ui/ConfirmDialog and ui/InlineConfirm (DS-5): the keyboard contract every consumer gets. The surfaces that use them
// (the New plan modal, Delete thread, the shortcuts overlay) are exercised in their own specs; this file holds what the primitives
// promise: Tab held inside, Escape and the scrim closing, focus handed back, a destructive answer needing its own click, and a
// confirm that cancels when focus leaves it.

const isNarrow = () => test.info().project.name === "desktop-1180";

/** The feedback form is the plainest screen with an unsaved-edits state: a title makes it dirty. */
async function dirtyFeedbackForm(page: Page): Promise<Locator> {
  await openDesk(page, "/feedback/new?from=%2Falerts");
  const title = page.getByRole("textbox", { name: /^Title/ });
  await title.fill("Wrong colour");
  return title;
}

test.describe("Dialog and ConfirmDialog", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

  test("a dialog holds Tab, locks the page, closes on Escape or the scrim, and gives focus back; Discard is its own click", async ({ page }) => {
    const title = await dirtyFeedbackForm(page);
    const cancel = page.getByRole("button", { name: "Cancel" });
    await cancel.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Discard this report?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toContainText("What you wrote");
    await expect(page.locator("html")).toHaveCSS("overflow", "hidden");

    // The neutral answer comes first and has the focus, so Enter cannot discard by accident.
    const keep = dialog.getByRole("button", { name: "Keep editing" });
    const discard = dialog.getByRole("button", { name: "Discard report" });
    await expect(keep).toBeFocused();
    await expect(dialog.getByRole("button")).toHaveText(["Keep editing", "Discard report"]);

    // Tab wraps inside the dialog in both directions.
    await page.keyboard.press("Tab");
    await expect(discard).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(keep).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(discard).toBeFocused();

    // Escape closes it, hands focus back to the control that opened it, and keeps the form.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(cancel).toBeFocused();
    await expect(title).toHaveValue("Wrong colour");
    await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");

    // A press on the dimmed page closes it too.
    await cancel.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/feedback\/new/);

    // Only the destructive answer leaves.
    await cancel.click();
    await dialog.getByRole("button", { name: "Discard report" }).click();
    await expect(page).toHaveURL(/\/alerts$/);
  });

  test("unsaved edits make the shell ask before a mode switch: Stay keeps the form, Leave page goes", async ({ page }) => {
    const title = await dirtyFeedbackForm(page);
    const top = page.locator(".dk-top");
    await top.getByRole("button", { name: /^Mode: / }).click();
    await page.getByRole("menu", { name: "Mode" }).getByRole("menuitemradio", { name: /^Fundamental/ }).click();

    const dialog = page.getByRole("dialog", { name: "Leave this page?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stay" })).toBeFocused();
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/feedback\/new/);
    await expect(title).toHaveValue("Wrong colour");

    await top.getByRole("button", { name: /^Mode: / }).click();
    await page.getByRole("menu", { name: "Mode" }).getByRole("menuitemradio", { name: /^Fundamental/ }).click();
    await page.getByRole("dialog", { name: "Leave this page?" }).getByRole("button", { name: "Leave page" }).click();
    await expect(page).not.toHaveURL(/\/feedback\/new/);
  });
});

test.describe("InlineConfirm", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical-alerts"));

  test("the delete confirm takes focus, closes on Escape with focus back on Delete, and cancels when focus leaves it", async ({ page }) => {
    await openDesk(page, "/alerts");
    await page.getByRole("table", { name: "Alert strategies" }).getByRole("row", { name: /Hammer 15m near S1/ }).click();
    const detail = isNarrow() ? page.getByRole("dialog", { name: "Details" }) : page.getByRole("complementary", { name: "Alert details" });
    await expect(detail.getByRole("heading", { name: "Hammer 15m near S1" })).toBeVisible();
    const del = detail.getByRole("button", { name: "Delete", exact: true });
    const confirm = detail.getByRole("group", { name: "Confirm deleting this alert strategy" });

    // Opening it swaps the trigger for the question; a destructive one starts on the safe answer.
    await del.click();
    await expect(confirm).toContainText("Delete this alert strategy?");
    await expect(confirm.getByRole("button")).toHaveText(["Keep", "Delete"]);
    await expect(confirm.getByRole("button", { name: "Keep" })).toBeFocused();

    // Escape closes it and puts focus back on the trigger.
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(del).toBeFocused();

    // Focus moving anywhere else cancels it, and focus stays where it went.
    await del.click();
    await expect(confirm).toBeVisible();
    const edit = detail.getByRole("link", { name: "Edit" });
    await edit.focus();
    await expect(confirm).toHaveCount(0);
    await expect(del).toBeVisible();
    await expect(edit).toBeFocused();

    // Nothing was deleted.
    await expect(detail.getByRole("heading", { name: "Hammer 15m near S1" })).toBeVisible();
  });
});
