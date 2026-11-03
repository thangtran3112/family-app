import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { stepBar } from "./clock-helpers";
import { expect, prepareDesk, test } from "./helpers";
import { placeOrder, replayRail } from "./hub-helpers";
import { openTicket } from "./lane-helpers";

// Keyboard and screen-reader behaviour of the Practice workspace (the five-reviewer pass): a lane has no transport of its own, the stop form hands focus
// back, the bottom panel is one tablist whose tabs name their panel, and the Marks and levels toggle keeps one name. A lane is one name of a freestyle
// thread (ADR-0025); the thread's clock is moved from the Summary or the clock route. The stub day is TSLA on Fri 2026-09-25 from 09:30 ET, at one-minute bars.

test.describe("Practice workspace: keyboard and names", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a lane is a read-only readout of the thread's time: no Play, Pause, Step or Jump on the chart, and links to the Summary clock and the Screen", async ({ page, context }) => {
    const { threadId } = await openTicket(page, context);
    const readout = page.getByTestId("thread-time-readout");
    await expect(readout).toContainText(PRACTICE_COPY.threadTime);
    await expect(readout.getByRole("link", { name: /on the Summary$/ })).toHaveAttribute("href", `/practice/thread?id=${threadId}`);
    await expect(readout.getByRole("link", { name: PRACTICE_COPY.tabScreen })).toHaveAttribute("href", `/practice/screen?thread=${threadId}`);
    for (const name of [/^Play/, /^Pause/, /^Step/, /^Jump/, /^Skip/, /^End/]) await expect(page.getByRole("button", { name }), `no ${name} on a lane`).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Jump forward" })).toHaveCount(0);
    // The clock still reaches the chart: the thread's clock route moves it and the readout follows.
    const before = await page.getByTestId("thread-clock-time").textContent();
    await stepBar(page);
    await expect(page.getByTestId("thread-clock-time")).not.toHaveText(before ?? "");
  });

  test("the stop form starts empty, says what is wrong at its field and stays open, and Escape hands focus back to Set stop", async ({ page, context }) => {
    await openTicket(page, context);
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
    await openTicket(page, context);
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

  test("a failed order says why on the ticket, at once, and the message is announced from a region that was already on the page", async ({ page, context }) => {
    await openTicket(page, context);
    await expect(page.locator('div[role="status"][aria-live="polite"]:not(:has(*))'), "the polite region is on the page, empty, before any message").toHaveCount(1);
    await expect(page.locator('div[role="status"][aria-live="polite"]:not(:has(*)) + div[role="alert"]:not(:has(*))'), "the assertive region (the polite one's sibling) is on the page, empty, before any message").toHaveCount(1);
    await page.route("**/api/desk/replay/sessions/*/{marks,orders}", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await placeOrder(page, "Buy");
    // The ticket's own error line (always on the page, empty until an order fails) carries the reason; no banner repeats it.
    const ticketError = page.getByRole("region", { name: "Order ticket" }).getByRole("alert");
    await expect(ticketError).toHaveText(PRACTICE_COPY.orderError);
    await expect(page.getByRole("button", { name: "Dismiss message" })).toHaveCount(0);
    await page.getByRole("region", { name: "Order ticket" }).getByLabel("Quantity").fill("50"); // editing the ticket clears it
    await expect(ticketError).toHaveText("");
  });
});
