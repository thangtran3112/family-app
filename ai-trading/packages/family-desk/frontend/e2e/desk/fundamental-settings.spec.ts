import type { Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";
import { fixture, mockFundamental, startInFundamental, watchGated } from "./fundamental-helpers";
import { expect, expectCleanScreen, openDesk, origin, prepareDesk, test, watchApi } from "./helpers";

// FD11 Settings, Fundamental variant (02n §b3): masking default, accounts, the holdings import, the scan filters and the
// alert templates. The holdings answer from the frozen fixtures; the settings routes are the real backend's.

type Holdings = { accounts: Array<{ id: number; label: string; type: string }>; import: { lots: number } };
type SettingsBody = { settings: Record<string, unknown> };

const storedSettings = async (page: Page) => ((await (await page.request.get(`${origin}/api/desk/settings`)).json()) as SettingsBody).settings;
const savedNote = (page: Page) => page.getByText("Saved", { exact: true });
const maskSwitch = (page: Page) => page.getByRole("switch", { name: "Hide values on every load" });
const maskToggle = (page: Page) => page.getByTestId("mask-toggle");

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

test("the Fundamental Settings show masking, accounts, the import, the scan filters and the alert templates", async ({ page }) => {
  const gated = watchGated(page);
  const holdings = fixture<Holdings>("holdings");
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/settings");
  const main = page.locator("#main-content");

  for (const name of ["Default mode", "Masking", "Accounts", "Holdings import", "Covered-call scan filters", "Fundamental alert templates", "Alerts", "Market data", "Trading"]) {
    await expect(main.getByRole("heading", { name, exact: true })).toBeVisible();
  }

  // Masking is on by default.
  await expect(maskSwitch(page)).toBeChecked();

  // Accounts: the owner's names and types, never an account number.
  const accounts = page.getByTestId("settings-accounts");
  for (const account of holdings.accounts) {
    await expect(accounts.getByTestId(`account-label-${account.id}`)).toHaveValue(account.label);
    await expect(accounts.getByTestId(`account-type-${account.id}`)).toHaveValue(account.type);
  }
  await expect(accounts).toContainText(COPY.tax);

  // Holdings import: state, source in words, the statement day, and the button.
  const importCard = page.getByTestId("settings-holdings-import");
  await expect(importCard.getByTestId("import-line")).toHaveText(`Holdings as of Fri 2026-10-23 close · IBKR Flex · ${holdings.import.lots} lots`);
  await expect(importCard).toContainText("Source: IBKR Flex");
  await expect(importCard).toContainText("Statement Fri 2026-10-23");
  await expect(page.getByTestId("import-now")).toBeEnabled();

  // Scan filters start from the engine defaults.
  const filters = page.getByTestId("settings-scan-filters");
  const defaults = { min_dte: "21", max_dte: "45", min_delta: "0.15", max_delta: "0.3", min_open_interest: "100", max_spread_pct: "10", min_bid: "0.1", cap_pct: "50" };
  for (const [key, value] of Object.entries(defaults)) await expect(filters.getByTestId(`scan-${key}`)).toHaveValue(value);
  await expect(filters.getByTestId("scan-save")).toBeDisabled();

  // Alert templates: three switches that cannot change, and the plain reason.
  const templates = page.getByTestId("settings-alert-templates");
  for (const name of ["Covered-call income", "Short-call risk", "Desk AI daily view"]) {
    await expect(templates.getByRole("switch", { name, exact: true })).toBeDisabled();
    await expect(templates.getByRole("switch", { name, exact: true })).not.toBeChecked();
  }
  await expect(templates.getByTestId("alert-templates-not-started")).toHaveText(COPY.alertTemplatesNotStarted);

  // Broker rows stay off with the orders-off reason.
  await expect(page.getByRole("region", { name: "Trading" }).getByRole("note")).toHaveText(COPY.ordersOff);

  // No account number or token anywhere on the page.
  const text = await main.innerText();
  expect(text).not.toMatch(/\bU\d{6,}\b|token|account number|query id/i);
  expect(gated()).toEqual([]);
  await expectCleanScreen(page);
});

test("an account name and type save through the accounts route", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  const patches: unknown[] = [];
  await page.route("**/api/desk/accounts/*", async (route) => {
    const body = route.request().postDataJSON() as { label?: string; type?: string };
    patches.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, label: body.label ?? "Taxable", type: body.type ?? "taxable" }) });
  });
  await openDesk(page, "/settings");
  const accounts = page.getByTestId("settings-accounts");

  await accounts.getByTestId("account-label-1").fill("  Brokerage  ");
  await accounts.getByTestId("account-label-1").press("Enter");
  await expect(accounts.getByText("Name saved")).toBeVisible();
  await expect(accounts.getByTestId("account-label-1")).toHaveValue("Brokerage");
  await accounts.getByTestId("account-type-1").selectOption("roth");
  await expect(accounts.getByText("Type saved")).toBeVisible();
  expect(patches).toEqual([{ label: "Brokerage" }, { type: "roth" }]);

  // An empty name is refused in place and nothing is sent.
  await accounts.getByTestId("account-label-2").fill("   ");
  await accounts.getByTestId("account-label-2").blur();
  await expect(accounts.getByText("Enter a name")).toBeVisible();
  expect(patches).toHaveLength(2);
});

test("Import now says it started, and says why when the import cannot start", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/settings");
  await page.getByTestId("import-now").click();
  await expect(page.getByTestId("import-message")).toHaveText(COPY.holdingsImporting);

  // A second page where the server refuses: another import ran a moment ago.
  await page.route("**/api/desk/holdings/import", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "an import ran in the last minute" }) }));
  await openDesk(page, "/settings");
  await page.getByTestId("import-now").click();
  await expect(page.getByTestId("import-message")).toHaveText("An import ran in the last minute · try again shortly");
});

test("scan filters name a problem before a save, never send an invalid draft, and persist a valid one", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  const api = watchApi(page);
  await openDesk(page, "/settings");
  const filters = page.getByTestId("settings-scan-filters");
  const save = filters.getByTestId("scan-save");

  // The shortest expiry above the longest: the problem sits on the longest, Save is blocked, nothing is sent.
  await filters.getByTestId("scan-min_dte").fill("50");
  await expect(filters.locator("#scan-max_dte-problem")).toHaveText("Must not be below 50");
  await expect(save).toBeDisabled();
  await filters.getByTestId("scan-cap_pct").fill("0");
  await expect(filters.locator("#scan-cap_pct-problem")).toHaveText("Must be between 1 and 100");
  expect(api.paths().filter((path) => path.startsWith("PUT "))).toEqual([]);

  // A valid draft saves, and the saved values come back after a reload.
  await filters.getByTestId("scan-cap_pct").fill("40");
  await filters.getByTestId("scan-max_dte").fill("60");
  await expect(filters.locator("#scan-max_dte-problem")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(savedNote(page)).toBeVisible();
  expect((await storedSettings(page)).covered_calls).toMatchObject({ min_dte: 50, max_dte: 60, cap_pct: 40 });
  await openDesk(page, "/settings");
  await expect(page.getByTestId("scan-min_dte")).toHaveValue("50");
  await expect(page.getByTestId("scan-max_dte")).toHaveValue("60");
  await expect(page.getByTestId("scan-cap_pct")).toHaveValue("40");

  // Reset to defaults fills the engine defaults and waits for Save.
  await page.getByTestId("scan-reset").click();
  await expect(page.getByTestId("scan-min_dte")).toHaveValue("21");
  await expect(page.getByTestId("scan-save")).toBeEnabled();
});

test("the masking default saves, comes back after a reload and moves the top-bar switch", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/settings");
  await expect(maskSwitch(page)).toBeChecked();
  await expect(maskToggle(page)).toHaveText(COPY.maskShow);

  await maskSwitch(page).click();
  await expect(maskSwitch(page)).not.toBeChecked();
  await expect(savedNote(page)).toBeVisible();
  expect((await storedSettings(page)).mask_values).toBe(false);

  // Values start shown on the next load: the top bar offers to hide them.
  await openDesk(page, "/settings");
  await expect(maskSwitch(page)).not.toBeChecked();
  await expect(maskToggle(page)).toHaveText(COPY.maskHide);

  // Restore the default.
  await maskSwitch(page).click();
  await expect(maskSwitch(page)).toBeChecked();
  await expect.poll(async () => (await storedSettings(page)).mask_values).toBe(true);
  await openDesk(page, "/settings");
  await expect(maskToggle(page)).toHaveText(COPY.maskShow);
});

test("the Technical Settings stay as they were, with none of the Fundamental cards", async ({ page }) => {
  const gated = watchGated(page);
  await openDesk(page, "/settings");
  await expect(page.getByRole("group", { name: "Default mode" })).toBeVisible();
  for (const name of ["Masking", "Accounts", "Holdings import", "Covered-call scan filters", "Fundamental alert templates"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId("mask-toggle")).toHaveCount(0);
  expect(gated()).toEqual([]);
});
