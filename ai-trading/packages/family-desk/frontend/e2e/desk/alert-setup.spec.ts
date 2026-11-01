import type { Locator, Page } from "@playwright/test";
import { NO_CHANNEL_NOTE } from "../../lib/desk/channelView.ts";
import { COPY } from "../../lib/desk/freshness.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";

// Board D10 (02m §c2): `/alerts/new` builds an alert from four steps, shows a live summary, saves a draft, and
// keeps `Turn on` disabled until live quotes run. The 1180 band keeps the summary in a drawer behind a tab.

type Strategy = {
  id: number;
  name: string;
  stage: string;
  status: string;
  version: number;
  frequency: string;
  source: { kind: string; label: string };
  spec: unknown;
};

const STRATEGIES = "/api/desk/alert-strategies";
const NVDA_SENTENCE = "At each 15-minute close during regular hours, alert when close crosses above VWAP; notify inbox.";
const isStrategyPost = (response: { request(): { method(): string }; url(): string }) =>
  response.request().method() === "POST" && new URL(response.url()).pathname === STRATEGIES;

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

/** The summary pane: the right rail at 1440, or the drawer behind the Summary tab at 1180 (opened here). */
async function openSummary(page: Page): Promise<Locator> {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: "Alert summary" });
  await page.getByRole("tab", { name: "Summary" }).click();
  return page.getByRole("dialog", { name: "Summary" });
}

/** Escape closes the 1180 drawer; at 1440 there is nothing to close. */
async function closeSummary(page: Page) {
  if (test.info().project.name !== "desktop-1180") return;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Summary" })).toBeHidden();
}

/** The alert the spec builds: NVDA greater than 215 on each 15m close, fired once. */
async function buildNvdaAbove215(page: Page) {
  await page.getByRole("textbox", { name: "Name" }).fill("NVDA above 215");
  await page.getByRole("combobox", { name: "Operator" }).selectOption({ label: "is greater than" });
  await page.getByRole("combobox", { name: "Compared with" }).selectOption("value");
  await page.getByRole("spinbutton", { name: "Value" }).fill("215");
  await page.getByRole("combobox", { name: "Check on" }).selectOption("bar_close_15m");
  await page.getByRole("radio", { name: "Once", exact: true }).check();
}

async function listStrategies(page: Page): Promise<Strategy[]> {
  const response = await page.request.get(STRATEGIES);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Strategy[];
}

async function strategyById(page: Page, id: number): Promise<Strategy> {
  const response = await page.request.get(`${STRATEGIES}/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Strategy;
}

/** Every object key in a value, at any depth. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
}

test("the prefilled form shows four steps, the plain-English summary, the NVDA chart, and a collapsed JSON panel", async ({ page }) => {
  // `?source=symbol:NVDA` prefills the symbol and the live check resolves it for the summary.
  await openDesk(page, "/alerts/new?source=symbol:NVDA");
  await expectCleanScreen(page);
  await expect(page.getByRole("heading", { name: "New alert strategy", level: 1 })).toBeVisible();
  for (const step of ["Source", "Condition", "Trigger", "Deliver"]) {
    await expect(page.getByRole("region", { name: step, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Symbols (comma separated)" })).toHaveValue("NVDA");
  const pane = await openSummary(page);
  await expect(pane.getByText(NVDA_SENTENCE, { exact: true })).toBeVisible();
  await expect(pane.getByText("Watches NVDA", { exact: true })).toBeVisible();
  await expect(pane.getByRole("region", { name: "NVDA 15m market chart" })).toBeVisible();
  // The JSON panel is offered but starts collapsed.
  await expect(pane.getByText("View JSON", { exact: true })).toBeVisible();
  await expect(pane.locator("details").filter({ hasText: "View JSON" })).not.toHaveAttribute("open");
  await closeSummary(page);
  await expectCleanScreen(page);
});

test("building the alert updates the summary sentence and the live check answers", async ({ page }) => {
  // The live check runs on every change; the summary follows it.
  const api = watchApi(page);
  await openDesk(page, "/alerts/new?source=symbol:NVDA");
  await buildNvdaAbove215(page);
  const pane = await openSummary(page);
  await expect(pane.getByText("At each 15-minute close during regular hours, alert when close is greater than 215; notify inbox.", { exact: true })).toBeVisible();
  await expect(pane.getByText("Alert level 215", { exact: true })).toBeVisible();
  await expect(pane.getByText("Watches NVDA", { exact: true })).toBeVisible();
  await closeSummary(page);
  expect(api.paths()).toContain("POST /api/desk/alert-strategies/validate");
  await expect(page.getByText("problem to fix")).toHaveCount(0);
  await expectCleanScreen(page);
});

test("clearing the symbol shows one problem to fix, Save draft is answered with it, and fixing it clears the banner", async ({ page }) => {
  // A problem shows a count banner; its plain message (no schema text, no dotted path) sits under the Source step.
  await openDesk(page, "/alerts/new?source=symbol:NVDA");
  await page.getByRole("textbox", { name: "Symbols (comma separated)" }).fill("");
  await expect(page.getByText("1 problem to fix", { exact: true })).toBeVisible();
  const source = page.getByRole("region", { name: "Source", exact: true });
  await expect(source.getByText("Symbols: Add at least 1 symbol.")).toBeVisible();
  await expect(page.getByText("watch.universe.symbols")).toHaveCount(0);
  await expect(page.getByText("after validation")).toHaveCount(0);
  await expect(page.getByRole("alert").getByRole("link", { name: "Symbols: Add at least 1 symbol." })).toHaveAttribute("href", "#alert-step-source");
  await expectCleanScreen(page);

  // Saving is answered by the server with the same problem, and nothing is created.
  const before = (await listStrategies(page)).length;
  const answered = page.waitForResponse(isStrategyPost);
  await page.getByRole("button", { name: "Save draft" }).click();
  expect((await answered).status()).toBe(422);
  await expect(page.getByText("1 problem to fix", { exact: true })).toBeVisible();
  expect(await listStrategies(page)).toHaveLength(before);

  // Fixing the symbol clears the banner.
  await page.getByRole("textbox", { name: "Symbols (comma separated)" }).fill("NVDA");
  await expect(page.getByText("1 problem to fix", { exact: true })).toBeHidden();
  await expectCleanScreen(page);
});

test("Save draft creates a draft with inbox only, and the strategy lists as Draft", async ({ page }) => {
  // Only the inbox channel is sent (Telegram and Slack are not set up), and the create answers 201.
  await openDesk(page, "/alerts/new?source=symbol:NVDA");
  await buildNvdaAbove215(page);
  const created = page.waitForResponse(isStrategyPost);
  await page.getByRole("button", { name: "Save draft" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const sent = JSON.parse(response.request().postData() ?? "{}") as { save_as: string; spec: { then: { alert: { channels: string[] } } } };
  expect(sent.save_as).toBe("draft");
  expect(sent.spec.then.alert.channels).toEqual(["inbox"]);
  await expect(page.getByText("Saved as a draft", { exact: true })).toBeVisible();
  await expectCleanScreen(page);

  // The stored strategy is a draft on NVDA, and the spec carries no order or paper-order key.
  const saved = (await response.json()) as Strategy;
  const detail = await strategyById(page, saved.id);
  expect(detail).toMatchObject({ name: "NVDA above 215", stage: "draft", status: "draft", frequency: "once" });
  expect(detail.source).toMatchObject({ kind: "symbol", label: "NVDA" });
  expect(keysDeep(detail.spec).filter((key) => /order/i.test(key))).toEqual([]);

  await page.getByRole("link", { name: "View alerts" }).click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole("row").filter({ hasText: "NVDA above 215" })).toContainText("Draft");
  await expectCleanScreen(page);
});

test("Turn on stays disabled with the runtime reason, and nothing on this screen starts the alert", async ({ page }) => {
  // Alerts have not started (no live quotes), so even a complete form cannot be turned on here.
  await openDesk(page, "/alerts/new?source=symbol:NVDA");
  await buildNvdaAbove215(page);
  await expect(page.locator("#main-content").getByText(COPY.alertsNotStarted, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeDisabled();
  // The only control that could start an alert is that disabled Turn on.
  await expect(page.getByRole("button", { name: /turn on|start|resume|activate/i })).toHaveCount(1);
  await expectCleanScreen(page);
});

test("Deliver: inbox is locked on, Telegram and Slack are not set up, and the no-channel note links to Settings", async ({ page }) => {
  // Telegram and Slack are not set up in the seed, so their boxes are disabled and say so.
  await openDesk(page, "/alerts/new?source=symbol:NVDA");
  const deliver = page.getByRole("region", { name: "Deliver", exact: true });
  const inbox = deliver.getByRole("checkbox", { name: /Desk inbox/ });
  await expect(inbox).toBeChecked();
  await expect(inbox).toBeDisabled();
  for (const channel of ["Telegram", "Slack"]) {
    const box = deliver.getByRole("checkbox", { name: new RegExp(`^${channel}`) });
    await expect(box).not.toBeChecked();
    await expect(box).toBeDisabled();
  }
  await expect(deliver.getByText("Not set up yet", { exact: true })).toHaveCount(2);
  await expect(deliver.getByRole("status")).toContainText(NO_CHANNEL_NOTE);
  await expect(deliver.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings");
  await expectCleanScreen(page);
});

test("?from=filter:3 prefills the source with the Gap up screener filter", async ({ page }) => {
  // The prefill resolves filter id 3 to its name and selects that filter in the Screener filter step.
  await openDesk(page, "/alerts/new?from=filter:3");
  await expect(page.getByRole("radio", { name: "Screener filter", exact: true })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Screener filter" })).toHaveValue("Gap up");
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveAttribute("placeholder", "Gap up alert");
  await expectCleanScreen(page);
});

test("?edit= loads the saved draft, and Save changes writes version 2", async ({ page }) => {
  // Editing a saved draft: values load from its spec, the save is a PUT, and no Turn on appears on this screen.
  await openDesk(page, "/alerts/new?edit=1");
  await expect(page.getByRole("heading", { name: "Edit alert strategy", level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("ORB 15m");
  await expect(page.getByRole("radio", { name: "Watchlist", exact: true })).toBeChecked();
  // Scoped to the Source step: the left rail has its own Watchlist select.
  await expect(page.getByRole("region", { name: "Source", exact: true }).getByRole("combobox", { name: "Watchlist" })).toHaveValue("Day movers");
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
  expect((await strategyById(page, 1)).version).toBe(1);

  await page.getByRole("textbox", { name: "Name" }).fill("ORB 15m revised");
  const put = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `${STRATEGIES}/1`);
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await put).status()).toBe(200);
  await expect(page.getByText("Saved as version 2", { exact: true })).toBeVisible();
  const after = await strategyById(page, 1);
  expect(after).toMatchObject({ version: 2, name: "ORB 15m revised" });
  await expectCleanScreen(page);
});
