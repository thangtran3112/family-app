import { test, expect, prepareDesk, openDesk, setScenario, expectCleanScreen, watchApi, MIDDAY } from "./helpers";
import type { Locator, Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";

// D9 Alerts (02m §c2): the strategy list, its detail (inline at 1440, a row-click drawer at 1180), pause/resume,
// turn on, the delivery Log, the paused banner and the bell.

const isNarrow = () => test.info().project.name === "desktop-1180";

/** The detail pane: inline at 1440, the 1180 drawer once a row is clicked. */
const detailPane = (page: Page): Locator =>
  isNarrow() ? page.getByRole("dialog", { name: "Details" }) : page.getByRole("complementary", { name: "Alert details" });

/** The strategy's status as the API reports it (not what the screen shows). */
async function strategyStatus(page: Page, name: string): Promise<string | undefined> {
  const response = await page.request.get("/api/desk/alert-strategies");
  const rows = (await response.json()) as { name: string; status: string }[];
  return rows.find((row) => row.name === name)?.status;
}

/** Resolves with the first browser request to the list endpoint whose query has every given parameter. */
const listRequest = (page: Page, params: Record<string, string>) =>
  page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/desk/alert-strategies" && Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
  });

test.describe("alerts list, detail, actions, log and bell", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical-alerts"));

  test("list shows the five strategies in last-fired order with their columns and a New alert strategy link", async ({ page }) => {
    await openDesk(page, "/alerts");
    await expectCleanScreen(page);
    const table = page.getByRole("table", { name: "Alert strategies" });
    // Frequency and Channels carry a drop priority, so they are the columns that leave at 1180.
    await expect(table.getByRole("columnheader")).toHaveText(
      isNarrow()
        ? ["Name", "Source", "Trigger", "Status", "Last fired", "Actions"]
        : ["Name", "Source", "Trigger", "Frequency", "Channels", "Status", "Last fired", "Actions"],
    );
    // Default sort is last fired, newest first; the draft that never fired comes last.
    await expect(table.locator("tbody tr td:first-child")).toHaveText([
      "Hammer 15m near S1",
      "High-of-day break",
      "VWAP reclaim",
      "ORB 15m",
      "Abnormal volume",
    ]);
    await expect(table.getByRole("cell", { name: "Active", exact: true })).toHaveCount(4);
    await expect(table.getByRole("row", { name: /Abnormal volume/ })).toContainText("Never fired");
    await expect(table.getByRole("row", { name: /Hammer 15m near S1/ })).toContainText("2026-10-15 15:15");
    const newStrategy = page.getByRole("link", { name: "New alert strategy" });
    await expect(newStrategy).toHaveAttribute("href", "/alerts/new");
    await newStrategy.click();
    await expect(page).toHaveURL(/\/alerts\/new$/);
    await expectCleanScreen(page);
  });

  test("status, sort and symbol filters send their parameters and change the rows", async ({ page }) => {
    await openDesk(page, "/alerts");
    const table = page.getByRole("table", { name: "Alert strategies" });
    const byName = listRequest(page, { sort: "name" });
    await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Name" });
    await byName; // the sort is server-side: the rows come back alphabetically
    await expect(table.locator("tbody tr td:first-child")).toHaveText([
      "Abnormal volume",
      "Hammer 15m near S1",
      "High-of-day break",
      "ORB 15m",
      "VWAP reclaim",
    ]);
    const draft = listRequest(page, { status: "draft", sort: "name" });
    await page.getByRole("combobox", { name: "Status" }).selectOption({ label: "Draft" });
    await draft;
    await expect(table.locator("tbody tr td:first-child")).toHaveText(["Abnormal volume"]);
    const symbol = listRequest(page, { status: "draft", symbol: "ZZZZ", sort: "name" });
    await page.getByRole("textbox", { name: "Symbol" }).fill("zzzz");
    await page.getByRole("textbox", { name: "Symbol" }).press("Enter");
    await symbol; // the symbol is upper-cased before it is sent
    await expect(page.getByText("No alert strategies match these filters")).toBeVisible();
    await expectCleanScreen(page);
  });

  test("selecting a strategy opens its detail with the plain sentence, recent fires with charts and JSON", async ({ page }) => {
    await openDesk(page, "/alerts");
    if (isNarrow()) {
      await expect(page.getByRole("dialog", { name: "Details" })).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Details" })).toBeVisible();
    } else {
      await expect(detailPane(page)).toContainText("Select an alert strategy to see its details");
    }
    await page.getByRole("table", { name: "Alert strategies" }).getByRole("row", { name: /Hammer 15m near S1/ }).click();
    const detail = detailPane(page);
    await expect(detail.getByRole("heading", { name: "Hammer 15m near S1" })).toBeVisible();
    await expect(detail.getByText("Active", { exact: true })).toBeVisible();
    await expect(detail).toContainText("At each 15-minute close during regular hours, alert when a hammer pattern appears");
    await expect(detail.getByRole("img", { name: "Price around the alert, 15 minute bars" })).toHaveCount(1);
    await expect(detail.getByRole("listitem")).toContainText("NVDA");
    await expect(detail.getByRole("listitem")).toContainText("Inbox · Delivered");
    await expect(detail.getByRole("listitem")).toContainText("Telegram · Held for quiet hours");
    await expect(detail.locator("pre")).toContainText('"runOn": "bar_close_15m"'); // the JSON is open by default
    await expectCleanScreen(page);
  });

  test("pausing an active strategy and resuming it updates the list, the detail and the API", async ({ page }) => {
    await openDesk(page, "/alerts");
    const hammer = page.getByRole("table", { name: "Alert strategies" }).getByRole("row", { name: /Hammer 15m near S1/ });
    await hammer.click();
    const detail = detailPane(page);
    await detail.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(detail.getByText(/^Paused/)).toBeVisible();
    await expect(hammer).toContainText("Paused");
    expect(await strategyStatus(page, "Hammer 15m near S1")).toBe("paused");
    await detail.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(hammer).toContainText("Active");
    expect(await strategyStatus(page, "Hammer 15m near S1")).toBe("active");
    await expectCleanScreen(page);
  });

  test("turning on a draft is refused with the plain sentence and the strategy stays a draft", async ({ page }) => {
    const api = watchApi(page);
    await openDesk(page, "/alerts");
    const abnormal = page.getByRole("table", { name: "Alert strategies" }).getByRole("row", { name: /Abnormal volume/ });
    await abnormal.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("alert").filter({ hasText: COPY.alertsNotStarted })).toBeVisible();
    await expect(abnormal).toContainText("Draft");
    await expect(abnormal.getByRole("button", { name: "Turn on" })).toBeVisible();
    expect(api.paths().filter((path) => /^POST \/api\/desk\/alert-strategies\/\d+\/resume$/.test(path))).toHaveLength(1);
    expect(await strategyStatus(page, "Abnormal volume")).toBe("draft");
    await expectCleanScreen(page);
  });

  test("the Log lists each delivery in plain words, newest first, and filters by result", async ({ page }) => {
    await openDesk(page, "/alerts");
    await page.getByRole("tab", { name: "Log" }).click();
    const log = page.getByRole("table", { name: "Alert delivery log" });
    await expect(log.locator("tbody tr")).toHaveCount(8); // one row per channel per fire: four inbox, four telegram
    await expect(log.locator("tbody tr td:nth-child(1)")).toHaveText([
      "2026-10-15 15:30",
      "2026-10-15 15:30",
      "2026-10-15 14:11",
      "2026-10-15 14:11",
      "2026-10-15 11:21",
      "2026-10-15 11:21",
      "2026-10-15 10:03",
      "2026-10-15 10:03",
    ]);
    await expect(log.getByRole("cell", { name: /^NVDA · / })).toHaveCount(8); // the symbol travels in the Alert column
    await expect(log.locator("tbody tr td:nth-child(4)")).toHaveText([
      "Held for quiet hours",
      "Delivered",
      "Delivered",
      "Delivered",
      "Could not deliver",
      "Delivered",
      "No channel connected",
      "Delivered",
    ]);
    await expect(log.locator("tbody tr td:nth-child(5)")).toHaveText([
      "Held until quiet hours end",
      "Delivered",
      "Delivered",
      "Delivered",
      "Couldn't deliver · will not retry",
      "Delivered",
      "No channel connected for telegram",
      "Delivered",
    ]);
    const failed = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/desk/alerts/log" && url.searchParams.get("status") === "failed";
    });
    await page.getByRole("combobox", { name: "Status" }).selectOption({ label: "Could not deliver" });
    await failed;
    await expect(log.locator("tbody tr")).toHaveCount(1);
    await expect(log).toContainText("Couldn't deliver · will not retry");
    await expectCleanScreen(page);
  });

  test("the bell counts three unread alerts; opening one or marking all read lowers the count", async ({ page }) => {
    await openDesk(page, "/alerts");
    await page.getByRole("button", { name: "Alerts, 3 unread" }).click();
    const panel = page.getByRole("dialog", { name: "Recent alerts" });
    await expect(panel.getByRole("listitem")).toHaveCount(4);
    await expect(panel.getByRole("button", { name: /^Unread: / })).toHaveCount(3);
    await panel.getByRole("button", { name: /^Unread: NVDA: Hammer 15m near S1/ }).click();
    await expect(page).toHaveURL(/\/technicals\?symbol=NVDA/);
    await page.getByRole("button", { name: "Alerts, 2 unread" }).click();
    await page.getByRole("dialog", { name: "Recent alerts" }).getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByRole("button", { name: "Alerts", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Recent alerts" }).getByRole("button", { name: /^Unread: / })).toHaveCount(0);
    await expectCleanScreen(page);
  });
});

test.describe("alerts banner follows the runtime", () => {
  test("a fresh seed says alerts start when quotes connect and its Log is empty; paused quotes say alerts are paused", async ({ page, context }) => {
    await prepareDesk(context, "technical");
    await openDesk(page, "/alerts");
    await expect(page.getByRole("status").filter({ hasText: COPY.alertsNotStarted })).toBeVisible();
    await page.getByRole("tab", { name: "Log" }).click();
    await expect(page.locator("#main-content")).toContainText("Nothing delivered yet");
    await expectCleanScreen(page);

    await prepareDesk(context, "technical-alerts");
    await setScenario(context, { now: MIDDAY, feedAgeMinutes: 90 });
    await openDesk(page, "/alerts", MIDDAY);
    await expect(page.getByRole("status").filter({ hasText: COPY.alertsPaused })).toBeVisible();
    await expectCleanScreen(page);
  });
});
