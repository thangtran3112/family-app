import { expect, test } from "@playwright/test";
import { openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

test("stock CL and future /CL keep distinct identity; add/delete and flip controls work", async ({ page }) => {
  await openDesk(page, "/watchlists");
  await page.getByLabel("Add a symbol").fill("AAPL");
  await page.getByRole("button", { name: "Add symbol" }).click();
  await expect(page.getByRole("status")).toContainText("Added AAPL", { timeout: 15_000 });
  await page.getByRole("button", { name: /Identity/ }).click();
  await page.getByRole("button", { name: "Flip cards" }).click();
  await expect(page.getByRole("article", { name: "CL technicals flip card", exact: true })).toContainText("Stock");
  await expect(page.getByRole("article", { name: "/CL technicals flip card", exact: true })).toContainText("Future");
  const cl = page.getByRole("article", { name: "CL technicals flip card", exact: true });
  await cl.focus();
  await page.keyboard.press("f");
  await expect(cl).toContainText("Desk Technical Bias");
  await cl.getByRole("button", { name: "1D" }).click();
  await expect(cl.getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Flip all" }).click();
  await page.getByRole("button", { name: /Day movers/ }).click();
  await page.getByRole("button", { name: "Flip cards" }).click();
  await page.getByRole("button", { name: "Flip all" }).click();
  const aapl = page.getByRole("article", { name: "AAPL technicals flip card" });
  await aapl.getByRole("button", { name: "Remove AAPL" }).click();
  await expect(aapl).toHaveCount(0);
});
