import type { Locator, Page } from "@playwright/test";
import { practiceText } from "../../lib/desk/freshness.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";
import { createStubSession } from "./hub-helpers";
import { replayRail } from "./swing-helpers";

// The Practice order ticket (owner directive): a broker-style ticket with a side, a quantity and an order type; Market, Limit,
// Stop and Stop-limit placed from it; a stop that is only ever optional; Close position beside the position. The stub day is TSLA
// on Fri 2026-09-25, replayed 09:30 to 09:40 ET at one-minute bars (TSLA near 380). A standalone session has an account of its own
// ($50,000, the thread default), so cash is the only size rule here as in a thread: the size and the prices below fit it, and the
// last test spends past it. A working order holds its notional back (at its limit, else its stop), so the orders a test leaves
// working must fit the $50,000 together.

async function openTicket(page: Page, context: Parameters<typeof createStubSession>[0]) {
  const id = await createStubSession(context);
  await openDesk(page, `/practice/replay?id=${id}`);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
  // Reveal two bars so the replay has a last price to trade at.
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByTestId("thread-clock-time")).not.toContainText("9:30:00");
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
    await expect(practice.getByRole("definition").filter({ hasText: "None" })).toBeVisible(); // the position's stop reads "None"
    await expectCleanScreen(page);

    // The stop is added afterwards, to the position, and stays optional.
    await practice.getByRole("button", { name: "Set stop" }).click();
    const form = practice.getByRole("form", { name: "Stop" });
    await form.getByRole("textbox", { name: "Stop loss" }).fill("1");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(practice.getByRole("definition").filter({ hasText: "1.00" }).first()).toBeVisible();

    await practice.getByRole("button", { name: "Close position" }).click();
    await expect(practice.getByText("No open position")).toBeVisible();
    await page.getByRole("tab", { name: "Marks" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");
  });

  test("a Buy while long adds to the position, a Sell of fewer shares sells part, and a Sell of more flips it", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    const buy = practice.getByRole("button", { name: "Buy", exact: true });
    const sell = practice.getByRole("button", { name: "Sell", exact: true });
    const quantity = practice.getByLabel("Quantity");
    const messages = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Dismiss message" }) }); // the route announcer is an alert too
    await quantity.fill("5");
    await buy.click();
    await expect(practice.getByText(/^Long · 5 shares/)).toBeVisible();
    await page.getByRole("button", { name: "Step", exact: true }).click(); // a later bar: the second fill is a different price
    await quantity.fill("3");
    await buy.click(); // already long: it adds, there is no "already open" refusal
    await expect(practice.getByText(/^Long · 8 shares/)).toBeVisible();
    await expect(messages).toHaveCount(0);

    await practice.getByRole("radio", { name: "Sell" }).click();
    await quantity.fill("2");
    await sell.click(); // fewer than the 8 held: a partial exit, the rest stays long
    await expect(practice.getByText(/^Long · 6 shares/)).toBeVisible();
    await quantity.fill("10");
    await sell.click(); // more than the 6 held: closes them and goes short with the other 4
    await expect(practice.getByText(/^Short · 4 shares/)).toBeVisible();
    await expect(messages).toHaveCount(0);

    await page.getByRole("tab", { name: "Marks" }).click();
    const marks = page.getByRole("tabpanel");
    for (const label of ["Practice buy 5", "Practice buy 3", "Practice sell 2", "Practice sell 10"]) await expect(marks).toContainText(label);
    await expectCleanScreen(page);
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
    // The server names the field it refused (stopPrice), so the sentence sits at that field once, not again in the message line.
    await expect(page.getByRole("alert").filter({ hasText: "A buy stop goes above the last price" })).toBeVisible();
    await expect(practice.getByRole("textbox", { name: "Stop price" })).toHaveAttribute("aria-invalid", "true");
    // A stop above the market (about 380) that the account can carry: 10 shares at 400 is $4,000 of the $50,000, and the stop-limit
    // below holds another $4,010, so both stay working.
    await practice.getByLabel("Quantity").fill("10");
    await practice.getByRole("textbox", { name: "Stop price" }).fill("400");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(orders(practice).getByText("Buy 10 · Stop 400.00")).toBeVisible();

    await type.selectOption("stop_limit");
    await practice.getByRole("textbox", { name: "Stop price" }).fill("400");
    await practice.getByRole("textbox", { name: "Limit price" }).fill("401");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(orders(practice).getByText("Buy 10 · Stop-limit 400.00 / 401.00")).toBeVisible();
    await expect(orders(practice).getByText("Working")).toHaveCount(2);
  });

  test("a standalone session has its own cash: a stop the account cannot carry is refused at the quantity, and a second order is held to what the first leaves", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    const type = practice.getByRole("combobox", { name: "Order type" });
    const refusal = page.getByRole("alert").filter({ hasText: /^Not enough practice cash/ });
    await type.selectOption("stop");
    await practice.getByRole("textbox", { name: "Stop price" }).fill("100000");
    await practice.getByRole("button", { name: "Buy", exact: true }).click(); // 100 shares at 100,000 is $10,000,000
    await expect(refusal).toHaveText("Not enough practice cash · $50,000 free");
    await expect(practice.getByLabel("Quantity")).toHaveAttribute("aria-invalid", "true");
    await expect(orders(practice).getByText("Working")).toHaveCount(0);

    // 100 shares at 400 is $40,000: it fits, and it holds that cash back, so the same order again has only $10,000 left.
    await practice.getByRole("textbox", { name: "Stop price" }).fill("400");
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(orders(practice).getByText("Buy 100 · Stop 400.00")).toBeVisible();
    await practice.getByRole("textbox", { name: "Stop price" }).fill("400"); // a placed order clears the price box
    await practice.getByRole("button", { name: "Buy", exact: true }).click();
    await expect(refusal).toHaveText("Not enough practice cash · $10,000 free");
    await expect(orders(practice).getByText("Working")).toHaveCount(1);
  });

  // Click-to-order (owner directive 2026-11-01): a click on a price of the chart offers Buy and Sell there, each named for the order it
  // places against the last print, and the order goes through the ticket's own path (its quantity, its cash rule, its refusals).
  const plotBox = async (page: Page) => (await page.locator("section[aria-label='TSLA 1m market chart'] canvas").first().boundingBox())!;
  const chartOrder = (page: Page) => page.getByRole("group", { name: "Chart order" });

  test("a click above the last print offers Buy stop and Sell limit at that price; Sell limit becomes a working order with the ticket's quantity", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    await practice.getByLabel("Quantity").fill("5");
    const box = await plotBox(page);
    await expect(chartOrder(page)).toHaveCount(0);
    await page.mouse.click(box.x + box.width * 0.4, box.y + 20);
    const popup = chartOrder(page);
    await expect(popup).toBeVisible();
    const price = (await popup.getByText(/^TSLA \d/).innerText()).replace("TSLA ", "");
    await expect(popup.getByRole("button", { name: `Buy stop ${price}` })).toBeVisible();
    await expect(popup.getByRole("button", { name: `Sell limit ${price}` })).toBeVisible();
    await expect(popup.getByText("Quantity 5 · set in the ticket")).toBeVisible();
    await expectCleanScreen(page);

    await popup.getByRole("button", { name: `Sell limit ${price}` }).click();
    await expect(chartOrder(page)).toHaveCount(0); // taken: the popup goes
    await expect(orders(practice).getByText(`Sell 5 · Limit ${price}`)).toBeVisible();
    await expect(orders(practice).getByText("Working")).toHaveCount(1);
    await expect(practice.getByLabel("Quantity"), "the ticket keeps its own draft").toHaveValue("5");
  });

  test("a click below the last print offers Buy limit and Sell stop; Escape closes the popup and nothing else", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    const box = await plotBox(page);
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height - 6);
    const popup = chartOrder(page);
    await expect(popup).toBeVisible();
    const price = (await popup.getByText(/^TSLA \d/).innerText()).replace("TSLA ", "");
    await expect(popup.getByRole("button", { name: `Buy limit ${price}` })).toBeVisible();
    await expect(popup.getByRole("button", { name: `Sell stop ${price}` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(orders(practice).getByText("Working")).toHaveCount(0); // a pick is not an order
    // The chart stays where it was: a second click opens a second popup, and a press outside the chart closes it.
    await page.mouse.click(box.x + box.width * 0.6, box.y + 20);
    await expect(popup).toBeVisible();
    await page.getByRole("heading", { name: "TSLA", level: 1 }).click();
    await expect(popup).toHaveCount(0);
  });

  test("a chart order the account cannot carry is refused at the ticket's Quantity, as a typed one is, and the popup stays for another try", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    await practice.getByLabel("Quantity").fill("100000"); // far beyond the $50,000
    const box = await plotBox(page);
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height - 6);
    const popup = chartOrder(page);
    await popup.getByRole("button", { name: /^Buy limit / }).click();
    await expect(page.getByRole("alert").filter({ hasText: /^Not enough practice cash/ })).toHaveText("Not enough practice cash · $50,000 free");
    await expect(practice.getByLabel("Quantity")).toHaveAttribute("aria-invalid", "true");
    await expect(popup).toBeVisible();
    await expect(orders(practice).getByText("Working")).toHaveCount(0);
    await practice.getByLabel("Quantity").fill("5");
    await popup.getByRole("button", { name: /^Buy limit / }).click();
    await expect(chartOrder(page)).toHaveCount(0);
    await expect(orders(practice).getByText("Working")).toHaveCount(1);
  });

  test("the ticket carries no guidance copy and no required-stop wording", async ({ page, context }) => {
    const practice = await openTicket(page, context);
    for (const text of [/type a stop price first/i, /your plan asks for a stop/i, /sizing hint/i, /required/i]) {
      await expect(practice.getByText(text)).toHaveCount(0);
    }
  });
});
