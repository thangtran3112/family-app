import type { Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";
import { expect, expectCleanScreen, openDesk, origin, prepareDesk, test, watchApi } from "./helpers";

// D11 Settings and More (02m §c2, §a3.8, §a3.9): the settings board, its saves, and the shell's alert wording.

type SettingsBody = { settings: Record<string, unknown> };
type StatusBody = { alerts: { state: string } };

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${origin}${path}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as T;
}
const storedSettings = async (page: Page) => (await getJson<SettingsBody>(page, "/api/desk/settings")).settings;
const alertsState = async (page: Page) => (await getJson<StatusBody>(page, "/api/desk/status")).alerts.state;

/** The "Saved" note in the page header, shown after each successful save. */
const savedNote = (page: Page) => page.getByText("Saved", { exact: true });
const pauseSwitch = (page: Page) => page.getByRole("switch", { name: "Pause all strategies", exact: true });
const quietStart = (page: Page) => page.getByLabel("Quiet hours start", { exact: true });
const quietEnd = (page: Page) => page.getByLabel("Quiet hours end", { exact: true });

/** One channel block (D11 `ChannelRows`): the nearest div that holds its heading and its "Send test" button. */
const channelRow = (page: Page, title: string) =>
  page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Send test", exact: true }) })
    .last();

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

test("Settings shows the Technical default, channels, quiet hours, data sources and disabled broker rows", async ({ page }) => {
  await openDesk(page, "/settings");
  await expect(page.locator("#main-content").getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // Default view is Technical; nothing is paused.
  await expect(page.getByRole("group", { name: "Default view" }).getByRole("radio", { name: "Technical" })).toBeChecked();
  await expect(pauseSwitch(page)).not.toBeChecked();

  // Desk inbox is always on; Telegram and Slack are not set up in this world (no bot is configured).
  const alerts = page.getByRole("region", { name: "Alerts" });
  await expect(alerts.getByText("Always on")).toBeVisible();
  await expect(alerts.getByText("Not set up yet")).toHaveCount(2);
  // A channel that cannot deliver never shows its box ticked, whatever was saved before.
  for (const name of ["Telegram", "Slack"]) {
    const box = alerts.getByRole("checkbox", { name: `Send alerts to ${name}` });
    await expect(box).not.toBeChecked();
    await expect(box).toBeDisabled();
  }

  // Quiet hours default to 22:00 to 07:00 when nothing is stored.
  await expect(quietStart(page)).toHaveValue("22:00");
  await expect(quietEnd(page)).toHaveValue("07:00");

  // Market data rows, in plain words (the freshness copy, read from /status).
  await expect(page.getByRole("region", { name: "Market data" }).getByRole("listitem")).toHaveText([
    "Quotes: Alpaca · Delayed 15 min",
    "Scans: Alpaca · Delayed 15 min",
    "Live IBKR quotes: not turned on · using delayed quotes",
    "Quote slots: 0 of 70",
    COPY.alertsNotStarted,
  ]);

  // Broker rows are switches that cannot change, with the orders-off reason; no order control.
  const trading = page.getByRole("region", { name: "Trading" });
  await expect(trading.getByRole("switch", { name: "Place orders", exact: true })).toBeDisabled();
  await expect(trading.getByRole("switch", { name: "IBKR order permission", exact: true })).toBeDisabled();
  await expect(trading.getByRole("note")).toHaveText(COPY.ordersOff);
  await expectCleanScreen(page);
});

test("quiet hours save when a field is left, survive a reload, keep unknown settings, and refuse an empty time", async ({ page }) => {
  const api = watchApi(page);
  await openDesk(page, "/settings");

  await quietStart(page).fill("21:30");
  await quietStart(page).blur();
  await expect(savedNote(page)).toBeVisible();
  await quietEnd(page).fill("06:30");
  await quietEnd(page).blur();
  await expect.poll(async () => (await storedSettings(page)).quiet_hours).toEqual({ start: "21:30", end: "06:30" });

  // Reload: the saved window comes back, and the unknown key seeded beside it is still there.
  await openDesk(page, "/settings");
  await expect(quietStart(page)).toHaveValue("21:30");
  await expect(quietEnd(page)).toHaveValue("06:30");
  expect((await storedSettings(page)).e2e_unknown).toEqual({ keep: true });

  // An empty time is refused in place with a plain message, and nothing is sent.
  api.clear();
  await quietStart(page).fill("");
  await quietStart(page).blur();
  await expect(page.locator("#quiet-hours-error")).toHaveText("Enter both quiet-hour times in 24-hour HH:MM format.");
  await expect(quietStart(page)).toHaveAttribute("aria-describedby", "quiet-hours-error");
  expect(api.paths().filter((path) => path.startsWith("PUT "))).toEqual([]);

  // The API refuses a malformed time too.
  const malformed = await page.request.put(`${origin}/api/desk/settings`, {
    data: { settings: { quiet_hours: { start: "25:00", end: "07:00" } } },
  });
  expect(malformed.status()).toBe(422);
  await expectCleanScreen(page);
});

test("Pause all strategies saves, shows the paused wording on Today and Alerts, and turns back off", async ({ page }) => {
  await openDesk(page, "/settings");
  await pauseSwitch(page).click();
  await expect(pauseSwitch(page)).toBeChecked();
  await expect(savedNote(page)).toBeVisible();
  expect((await storedSettings(page)).pause_all).toBe(true);
  expect(await alertsState(page)).toBe("paused_by_user");

  // The status bar on every screen, and the banner on Alerts, say so.
  await openDesk(page, "/");
  await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText(COPY.alertsPausedByUser);
  await openDesk(page, "/alerts");
  await expect(page.locator("#main-content")).toContainText(COPY.alertsPausedByUser);
  await expectCleanScreen(page);

  // Turning it off restores the state from before: no live strategies, so alerts wait for quotes.
  await openDesk(page, "/settings");
  await pauseSwitch(page).click();
  await expect(pauseSwitch(page)).not.toBeChecked();
  expect((await storedSettings(page)).pause_all).toBe(false);
  expect(await alertsState(page)).toBe("not_started");
  await openDesk(page, "/alerts");
  await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText(COPY.alertsNotStarted);
});

test.describe("with four alert fires", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical-alerts"));

  test("live strategies show Alerts on, and Pause all replaces that with the paused wording", async ({ page }) => {
    await openDesk(page, "/alerts");
    await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText(COPY.alertsRunning);
    await expect(page.locator("#main-content")).not.toContainText(COPY.alertsPausedByUser);

    await openDesk(page, "/settings");
    await pauseSwitch(page).click();
    await expect(pauseSwitch(page)).toBeChecked();
    await expect(savedNote(page)).toBeVisible();
    expect(await alertsState(page)).toBe("paused_by_user");

    await openDesk(page, "/alerts");
    await expect(page.locator("#main-content")).toContainText(COPY.alertsPausedByUser);
    await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText(COPY.alertsPausedByUser);
    await expectCleanScreen(page);
  });
});

test("Default view moves between Technical and Fundamental, is saved, and keeps the Settings screen", async ({ page }) => {
  await openDesk(page, "/settings");
  const view = page.getByRole("group", { name: "Default view" });

  await view.getByRole("radio", { name: "Fundamental" }).click();
  await expect(savedNote(page)).toBeVisible();
  await expect.poll(async () => (await storedSettings(page)).default_view).toBe("fundamental");
  // Choosing a view only remembers it: this screen stays put, with no lane switch or interstitial.
  await expect(view.getByRole("radio", { name: "Fundamental" })).toBeChecked();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("#main-content").getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await view.getByRole("radio", { name: "Technical" }).click();
  await expect.poll(async () => (await storedSettings(page)).default_view).toBe("technical");
  await expect(view.getByRole("radio", { name: "Technical" })).toBeChecked();
  await expectCleanScreen(page);
});

test("Send test reports sent for the inbox, and not connected in plain words for a linked Telegram with no bot wired", async ({ page }) => {
  await openDesk(page, "/settings");
  const inbox = channelRow(page, "Desk inbox");
  await inbox.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(inbox.getByRole("status")).toHaveText("Test message sent");

  // Telegram has no test control until a chat id is linked (the Connect form's PUT); this world has no bot, so the test says so.
  const linked = await page.request.put(`${origin}/api/desk/settings/channels/telegram`, { data: { chat_id: "123456789" } });
  expect(linked.ok()).toBeTruthy();
  await openDesk(page, "/settings");
  const telegram = channelRow(page, "Telegram");
  await expect(telegram.getByText("Connected", { exact: true })).toBeVisible();
  await telegram.getByRole("button", { name: "Send test", exact: true }).click();
  await expect(telegram.getByRole("status")).toHaveText("Not connected yet · nothing was sent");
  await expectCleanScreen(page);
});

test("More shows the same settings content under its own title", async ({ page }) => {
  await openDesk(page, "/more");
  await expect(page.locator("#main-content").getByRole("heading", { name: "More", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Default view" }).getByRole("radio", { name: "Technical" })).toBeChecked();
  await expect(pauseSwitch(page)).toBeVisible();
  await expect(quietStart(page)).toHaveValue("22:00");
  await expect(page.getByRole("region", { name: "Market data" })).toContainText("Quotes: Alpaca · Delayed 15 min");
  await expect(page.getByRole("region", { name: "Trading" }).getByRole("switch", { name: "Place orders", exact: true })).toBeDisabled();
  await expectCleanScreen(page);
});

test("while a save is in flight the controls are disabled, so a second edit sends no second PUT", async ({ page }) => {
  // Hold the first PUT open; GETs pass straight through.
  let puts = 0;
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/desk/settings", async (route, request) => {
    if (request.method() === "PUT") {
      puts += 1;
      await saveHeld;
    }
    await route.continue();
  });

  await openDesk(page, "/settings");
  await quietStart(page).fill("21:30");
  await quietStart(page).blur();
  await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
  await expect.poll(() => puts).toBe(1);

  // A second edit has nowhere to go: the pause switch and the end time are disabled until the save lands.
  await expect(pauseSwitch(page)).toBeDisabled();
  await expect(quietEnd(page)).toBeDisabled();

  releaseSave();
  await expect(savedNote(page)).toBeVisible();
  expect(puts).toBe(1);
  await openDesk(page, "/settings");
  await expect(quietStart(page)).toHaveValue("21:30");
  expect(puts).toBe(1);
});
