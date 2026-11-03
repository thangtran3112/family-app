import { openTicket } from "./lane-helpers";
import { expect, prepareDesk, test } from "./helpers";

// D-214: an order that costs more than the buying power is refused in one place. At 1180 the Buy under the chart ("Practice buttons") is
// the same control as the Practice column's, so it carries the same refusal (off, with the reason as its description) and the sentence
// shows once. At 1440 the ticket's own Buy is the only one. The stub TSLA is near 380 and the thread has $50,000: 200 shares do not fit.

test.describe("Practice order over the buying power", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("every Buy and Sell is off with the same reason, and the sentence shows once", async ({ page, context }) => {
    const { practice } = await openTicket(page, context);
    const sentence = page.getByText(/^Exceeds buying power · this order costs/);
    const strip = page.getByRole("group", { name: "Practice buttons" });
    const wide = test.info().project.name === "desktop-1180";

    await expect(sentence).toHaveCount(0);
    await practice.getByLabel("Quantity").fill("200");
    await expect(sentence).toHaveCount(1);
    const reason = (await sentence.textContent()) ?? "";
    const buys = [practice.getByRole("button", { name: "Buy", exact: true })];
    if (wide) buys.push(strip.getByRole("button", { name: "Buy", exact: true }), strip.getByRole("button", { name: "Sell", exact: true }));
    for (const button of buys) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleDescription(new RegExp(reason.replace(/[$.]/g, "\\$&")));
    }

    if (wide) await strip.getByRole("button", { name: "Buy", exact: true }).click({ force: true }); // a forced click sends nothing and prints nothing
    await expect(sentence).toHaveCount(1);
    await expect(page.getByRole("alert").filter({ hasText: /Not enough practice cash|Exceeds buying power/ })).toHaveCount(0);

    await practice.getByLabel("Quantity").fill("1");
    await expect(sentence).toHaveCount(0);
    for (const button of buys.slice(0, 2)) await expect(button).toBeEnabled();
  });
});
