import type { Locator, Page } from "@playwright/test";
import { PRACTICE_COPY, practiceText } from "../../lib/desk/freshness.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";
import { createStubSession } from "./hub-helpers";
import { replayRail } from "./swing-helpers";

// The Practice order ticket (owner directive): a broker-style ticket with a side, a quantity and an order type; Market, Limit,
// Stop and Stop-limit placed from it; a stop that is only ever optional; Close position beside the position. The stub day is TSLA
// on Fri 2026-09-25, replayed 09:30 to 09:40 ET at one-minute bars. A standalone session has no account, so the cash rule is
// covered in practice.spec.ts (a thread session) and here only the shape of a ticket is.

async function openTicket(page: Page, context: Parameters<typeof createStubSession>[0]) {
  const id = await createStubSession(context);
  await openDesk(page, `/practice/replay?id=${id}`);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
  // Reveal two bars so the replay has a last price to trade at.
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd")).not.toContainText("9:30:00");
  return replayRail(page, "Practice");
}

const orders = (practice: Locator) => practice.getByRole("region", { name: "Orders" });

test.describe("Practice order ticket", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a market buy needs only a quantity; a stop is optional and Close position sits with the position", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    await expect(practice.getByText("No open position")).toBeVisible();
    await expect(practice.getByRole("button", { name: "Close position" }), "nothing to close while flat").toHaveCount(0);
    await practice.getByLabel("Quantity").fill("5");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Dismiss message" }) })).toHaveCount(0); // no stop, no refusal (the route announcer is an alert too, so only the message toast counts)
    await expect(practice.getByText(/^Long · 5 shares/)).toBeVisible();
    await expect(practice.getByRole("definition").filter({ hasText: "none" })).toBeVisible(); // the position's stop reads "none"
    await expectCleanScreen(page);

    // The stop is added afterwards, to the position, and stays optional.
    await practice.getByRole("button", { name: "Set stop" }).click();
    const form = practice.getByRole("form", { name: "Stop" });
    await form.getByRole("textbox", { name: "Stop price" }).fill("1");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(practice.getByRole("definition").filter({ hasText: "1.00" }).first()).toBeVisible();

    await practice.getByRole("button", { name: "Close position" }).click();
    await expect(practice.getByText("No open position")).toBeVisible();
    await page.getByRole("tab", { name: "Marks" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");
  });

  test("Sell is a short entry with the same quantity field, and a ticket the user got wrong names the field", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    await practice.getByRole("radio", { name: "Sell" }).click();
    await practice.getByLabel("Quantity").fill("0");
    await practice.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(practice.getByText("Quantity: a whole number of 1 or more")).toBeVisible();
    await expect(practice.getByLabel("Quantity")).toHaveAttribute("aria-invalid", "true");
    await practice.getByLabel("Quantity").fill("3");
    await expect(practice.getByText("Quantity: a whole number of 1 or more")).toHaveCount(0);
    await practice.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(practice.getByText(/^Short · 3 shares/)).toBeVisible();
  });

  test("a limit order waits on the tape as a working order, can be cancelled, and a limit through the market fills at once", async ({ page, context }) => {
    const api = watchApi(page);
    const practice = await openTicket(page, context);
    await practice.getByRole("combobox", { name: "Order type" }).selectOption("limit");
    await practice.getByLabel("Quantity").fill("4");
    await practice.getByRole("textbox", { name: "Limit price" }).fill("1");
    await expect(practice.getByRole("button", { name: "Buy", exact: true })).toHaveAccessibleDescription("Buy 4 TSLA · Limit · limit 1.00");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(orders(practice).getByText("Buy 4 · Limit 1.00")).toBeVisible();
    await expect(orders(practice).getByText("Working")).toBeVisible();
    await expect(practice.getByText("No open position")).toBeVisible(); // a working order holds nothing
    expect(api.paths().some((path) => /^POST \/api\/desk\/replay\/sessions\/\d+\/orders$/.test(path))).toBe(true);

    await orders(practice).getByRole("button", { name: /^Cancel order: Buy 4/ }).click();
    await expect(orders(practice).getByText("Cancelled")).toBeVisible();
    await expect(orders(practice).getByRole("button", { name: /^Cancel order/ })).toHaveCount(0);

    await practice.getByRole("textbox", { name: "Limit price" }).fill("100000");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(practice.getByText(/^Long · 4 shares/)).toBeVisible(); // a buy limit above the market is marketable
    await expectCleanScreen(page);
  });

  test("a stop order is placed at its trigger, a stop on the wrong side of the market is refused in plain words, and Stop-limit takes both prices", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    const type = practice.getByRole("combobox", { name: "Order type" });
    await type.selectOption("stop");
    await practice.getByRole("textbox", { name: "Stop price" }).fill("1");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "A buy stop goes above the last price" })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss message" }).click();
    await practice.getByRole("textbox", { name: "Stop price" }).fill("100000");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(orders(practice).getByText("Buy 100 · Stop 100000.00")).toBeVisible();

    await type.selectOption("stop_limit");
    await practice.getByRole("textbox", { name: "Stop price" }).fill("100000");
    await practice.getByRole("textbox", { name: "Limit price" }).fill("100001");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(orders(practice).getByText("Buy 100 · Stop-limit 100000.00 / 100001.00")).toBeVisible();
    await expect(orders(practice).getByText("Working")).toHaveCount(2);
  });

  test("the ticket carries no guidance copy and no required-stop wording", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    for (const text of [/type a stop price first/i, /your plan asks for a stop/i, /sizing hint/i, /required/i]) {
      await expect(practice.getByText(text)).toHaveCount(0);
    }
    await expect(page.getByText(PRACTICE_COPY.tradeAlreadyOpen)).toHaveCount(0);
  });
});
