import { expect, test } from "@playwright/test";
import template from "../../contracts/templates/vwap-reclaim.json" with { type: "json" };
import { api, openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

test("template creates draft v1, alert_only real tick alerts, and v1 stays immutable", async ({ page }) => {
  await openDesk(page, "/strategies/new");
  await page.getByRole("button", { name: /VWAP reclaim/ }).click();
  await page.getByRole("checkbox", { name: /I reviewed/ }).check();
  await page.getByRole("button", { name: "Create reviewed draft" }).click();
  await expect(page).toHaveURL(/\/strategies\?id=\d+/);
  const id = new URL(page.url()).searchParams.get("id")!;
  const versionsBefore = await (await api(page, `/api/desk/strategies/${id}/versions`)).json();
  expect(versionsBefore).toHaveLength(1);
  const immutableV1 = versionsBefore[0].spec;

  await page.getByRole("button", { name: /Alert only/ }).click();
  const move = page.getByRole("dialog", { name: "Move this strategy to alert only?" });
  await expect(move).toContainText("It cannot move back to draft.");
  await move.getByRole("button", { name: "Move to alert only" }).click();
  await expect(move).toHaveCount(0);
  await expect(page.getByText(/alert only/i).first()).toBeVisible();
  const tick = await api(page, "/api/desk/__e2e/tick", { method: "POST" });
  expect(tick.ok()).toBeTruthy();
  expect((await tick.json()).first.new_signals).toBe(1);
  await page.goto("/");
  await expect(page.getByRole("region", { name: /Alerts/ })).toContainText("NVDA");

  await page.goto(`/strategies?id=${id}`);
  await page.getByLabel("Strategy name").fill("VWAP reclaim revised");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.getByText("Versions · 2")).toBeVisible();
  const versionsAfter = await (await api(page, `/api/desk/strategies/${id}/versions`)).json();
  expect(versionsAfter).toHaveLength(2);
  expect(versionsAfter[0].spec).toEqual(immutableV1);
});

test("dirty editor guards Back cancel/accept and preserves Forward navigation", async ({ page }) => {
  const strategy = await (await api(page, "/api/desk/strategies", { method: "POST", data: { name: "Navigation guard" } })).json();
  await api(page, `/api/desk/strategies/${strategy.id}/versions`, { method: "POST", data: { spec: template } });
  const id = strategy.id;
  await openDesk(page, "/strategies");
  await page.getByRole("link", { name: "Navigation guard" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/strategies\\?id=${id}$`));
  await page.getByLabel("Strategy name").fill("Unsaved navigation check");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(new RegExp(`/strategies\\?id=${id}$`));
  await expect(page.getByLabel("Strategy name")).toHaveValue("Unsaved navigation check");

  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page).not.toHaveURL(new RegExp(`/strategies\\?id=${id}$`));
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(new RegExp(`/strategies\\?id=${id}$`));
});

test("direct and recovery entries guard shell navigation and reload", async ({ page }) => {
  const strategy = await (await api(page, "/api/desk/strategies", { method: "POST", data: { name: "Recovery guard" } })).json();
  await openDesk(page, `/strategies?id=${strategy.id}`);
  await page.getByLabel("Strategy name").fill("Unsaved recovery draft");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Today", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/strategies\\?id=${strategy.id}$`));
  await expect(page.getByLabel("Strategy name")).toHaveValue("Unsaved recovery draft");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => location.reload()).catch(() => undefined);
  await expect(page.getByLabel("Strategy name")).toHaveValue("Unsaved recovery draft");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "Today", exact: true }).first().click();
  await expect(page).toHaveURL("/");
});
