import type { Page } from "@playwright/test";
import { practiceText } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { createStubSession } from "./hub-helpers";
import { replayRail } from "./swing-helpers";

// Keyboard and screen-reader behaviour of the Practice workspace (the five-reviewer pass): the Jump panel and the stop form hand focus
// back, the bottom panel is one tablist whose tabs name their panel, and the Marks and levels toggle keeps one name. The stub day is TSLA
// on Fri 2026-09-25, replayed 09:30 to 09:40 ET at one-minute bars.

async function openStub(page: Page, context: Parameters<typeof createStubSession>[0]) {
  const id = await createStubSession(context);
  await openDesk(page, `/practice/replay?id=${id}`);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByTestId("thread-clock-time")).not.toContainText("9:30:00");
}

test.describe("Practice workspace: keyboard and names", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the Jump panel opens on its first button, holds a form without menu roles, and gives focus back on Escape and on a choice", async ({ page, context }) => {
    await openStub(page, context);
    const jump = page.getByTestId("thread-clock").getByRole("button", { name: /^Jump/ });
    const clock = page.getByTestId("thread-clock-time");
    await jump.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Jump forward" });
    await expect(panel.getByRole("button", { name: "+5 min" })).toBeFocused();
    await expect(panel.getByRole("menuitem"), "a form may not sit inside a menu").toHaveCount(0);
    await expect(panel.getByLabel("To a time (ET)")).toBeVisible();
    await expect(panel.getByText("Shift →")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(jump).toBeFocused();

    const before = await clock.textContent();
    await jump.click();
    await panel.getByRole("button", { name: "+5 min" }).click();
    await expect(panel).toHaveCount(0);
    await expect(jump).toBeFocused();
    await expect(clock).not.toHaveText(before ?? "");
  });

  test("the stop form starts empty, says what is wrong at its field and stays open, and Escape hands focus back to Set stop", async ({ page, context }) => {
    await openStub(page, context);
    const practice = await replayRail(page, "Practice");
    await practice.getByLabel("Quantity").fill("5");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(practice.getByText(/^Long · 5 shares/)).toBeVisible();

    const setStop = practice.getByRole("button", { name: "Set stop" });
    await setStop.click();
    const form = practice.getByRole("form", { name: "Stop loss" });
    const field = form.getByRole("textbox", { name: "Stop loss" });
    await expect(field).toBeFocused();
    await expect(field, "no last price is prefilled: a stop at the last price is no stop").toHaveValue("");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByText("Stop loss: a number above 0")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("0x10");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByText("Stop loss: a number above 0"), "hex is not a price").toBeVisible();

    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(setStop).toBeFocused();

    await setStop.click();
    await page.getByRole("form", { name: "Stop loss" }).getByRole("button", { name: "Cancel" }).click();
    await expect(setStop).toBeFocused();
  });

  test("the bottom panel is one tablist whose tabs name their panel, arrows move between them, and the toggle keeps one name", async ({ page, context }) => {
    await openStub(page, context);
    const tabs = page.getByRole("tablist", { name: "Bottom panel" });
    const toggle = page.getByRole("button", { name: "Marks and levels panel" });
    const open = (await toggle.getAttribute("aria-expanded")) === "true";
    if (!open) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    const marks = tabs.getByRole("tab", { name: "Marks" });
    const levels = tabs.getByRole("tab", { name: "Levels" });
    await expect(marks).toHaveAttribute("aria-selected", "true");
    const panelId = await marks.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    await expect(page.locator(`[id="${panelId}"]`)).toHaveAttribute("role", "tabpanel");
    await marks.focus();
    await page.keyboard.press("ArrowRight");
    await expect(levels).toBeFocused();
    await expect(levels).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await levels.getAttribute("id")) ?? "");

    await toggle.click();
    await expect(toggle, "same name, state in aria-expanded").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
  });

  test("a key that cannot mark says why, and the message is announced from a region that was already on the page", async ({ page, context }) => {
    await openStub(page, context);
    await expect(page.locator('div[role="status"][aria-live="polite"]:not(:has(*))'), "the polite region is on the page, empty, before any message").toHaveCount(1);
    await page.keyboard.press("x");
    const note = page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss message" }) });
    await expect(note).toContainText("No open practice trade to exit");
    await note.getByRole("button", { name: "Dismiss message" }).click();
    await expect(note).toHaveCount(0);
  });
});
