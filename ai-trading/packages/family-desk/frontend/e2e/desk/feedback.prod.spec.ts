import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Production acceptance of the Feedback log (02s P3): one real bug and one real feature request filed through the form as the
// dedicated Clerk test user, then read back from the dashboard. Like the "production test user" test in `e2e/auth.spec.ts` it
// hits the live Desk, runs only through `pnpm test:e2e:prod` (`playwright.prod.config.ts`), and skips when the credentials are
// absent. Credentials come from FAMILY_DESK_TEST_USERNAME / FAMILY_DESK_TEST_PASSWORD in ai-trading/temp/.env, are never
// printed, and never leave this run. It never signs out, so the profile keeps its session.
//
// The bug is a defect someone actually saw while walking the Desk. It is read from `bug-finding.json` in the run directory
// ({ route, title, body, expected }) instead of being written here, so this file never carries an invented defect.
const deskOrigin = "https://trading.tobytran.dev";
const runDir = "/Users/tobytran/personal/local-llm/hermes/hermes-setup/runs/desk-feedback-log-20261026/p3";
const testUsername = process.env.FAMILY_DESK_TEST_USERNAME;
const testPassword = process.env.FAMILY_DESK_TEST_PASSWORD;

const REQUEST = {
  title: "Show the open report count on the Feedback menu item",
  body: "The account menu lists Feedback with no number. A small count of open reports beside it would show at a glance whether anything is waiting.",
  searchTerm: "account menu",
};
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

type Filed = { ref: string; title: string; kind: "bug" | "request"; screenshotAttached: boolean };

test.describe("production test user · feedback log", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!testUsername || !testPassword, "FAMILY_DESK_TEST_USERNAME / FAMILY_DESK_TEST_PASSWORD are not set");
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.config.metadata.production, "run it through `pnpm test:e2e:prod`");
  });

  let context: BrowserContext;
  let page: Page;
  const filed: { bug?: Filed; request?: Filed } = {};

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!testUsername || !testPassword || !testInfo.config.metadata.production) return;
    mkdirSync(runDir, { recursive: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    await page.goto(`${deskOrigin}/`);
    await expect(page).toHaveURL(/trading-hub\.tobytran\.dev\/login\?returnTo=/, { timeout: 30_000 });
    await page.getByLabel("Email address").fill(testUsername);
    await page.locator("input[name=password]").fill(testPassword);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // Clerk can stop a password sign-in on an extra step; name the dashboard setting instead of timing out.
    const blocked = page.getByText(/Check your email|Setup your organization/).first();
    await Promise.race([
      page.waitForURL(`${deskOrigin}/**`, { timeout: 45_000 }).catch(() => undefined),
      blocked.waitFor({ timeout: 45_000 }).catch(() => undefined),
    ]);
    await expect(
      blocked,
      '"Check your email" = Clerk Client Trust (new-device verification) is on; "Setup your organization" = the instance requires organization membership',
    ).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`^${deskOrigin}/`));
  });

  // No sign-out and no context.close(): the profile keeps its session for later runs.

  const form = () => page.getByRole("form", { name: "Report a problem" });
  const sentHeading = () => page.getByRole("heading", { name: /^F-\d{3,}$/ });

  async function fillAndSend(fields: { title: string; body: string; expected?: string }) {
    await page.getByRole("textbox", { name: /^Title/ }).fill(fields.title);
    await page.getByRole("textbox", { name: /^(What happened\?|What should it do\?)$/ }).fill(fields.body);
    if (fields.expected) await page.getByRole("textbox", { name: "What did you expect?" }).fill(fields.expected);
  }

  test("files a real bug at 1440 x 900 with the captured context and a real PNG screenshot", async () => {
    expect(existsSync(`${runDir}/bug-finding.json`), `write ${runDir}/bug-finding.json from a defect actually seen on the Desk`).toBe(true);
    const finding = JSON.parse(readFileSync(`${runDir}/bug-finding.json`, "utf8")) as { route: string; title: string; body: string; expected: string };

    // The screenshot is of the screen the defect is on, taken in-process, so it is a genuine image.
    await page.goto(`${deskOrigin}${finding.route}`);
    await page.waitForLoadState("networkidle");
    const shot = await page.screenshot();
    expect(shot.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(shot.length).toBeLessThan(MAX_SCREENSHOT_BYTES);

    await page.goto(`${deskOrigin}/feedback/new?from=${encodeURIComponent(finding.route)}`);
    await expect(page.getByRole("radio", { name: "Bug" })).toBeChecked();
    await page.getByRole("radio", { name: "P2" }).check();
    await expect(page.getByRole("radio", { name: "P2" })).toBeChecked();
    const where = page.getByRole("region", { name: "Where were you?" });
    await expect(where).toContainText(finding.route);
    await expect(where).toContainText(/desk-/);
    await fillAndSend(finding);
    await page.getByLabel("Choose screenshots").setInputFiles({ name: "desk-screen-1440x900.png", mimeType: "image/png", buffer: shot });
    await expect(page.getByText(/· PNG · uploaded/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("1 of 6")).toBeVisible();
    await expect(form()).toContainText("Ready");
    await page.getByRole("button", { name: "Send report" }).click();

    await expect(sentHeading()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Sent · thanks, it's on the Desk's list" })).toBeVisible();
    const ref = (await sentHeading().textContent())!.trim();
    await expect(page.getByRole("region", { name: ref })).toContainText("1 screenshot");
    filed.bug = { ref, title: finding.title, kind: "bug", screenshotAttached: true };
  });

  test("files a real feature request with no severity and no screenshot, and the sent state shows its F-nnn id", async () => {
    await page.goto(`${deskOrigin}/feedback/new?from=%2Ffeedback`);
    await page.getByRole("radio", { name: "Feature request" }).click();
    await expect(page.getByRole("radiogroup", { name: "Severity" })).toHaveCount(0);
    await fillAndSend(REQUEST);
    await page.getByRole("button", { name: "Send report" }).click();

    await expect(sentHeading()).toBeVisible({ timeout: 30_000 });
    const ref = (await sentHeading().textContent())!.trim();
    expect(ref).toMatch(/^F-\d{3,}$/);
    await expect(page.getByRole("region", { name: ref })).toContainText("0 screenshots");
    filed.request = { ref, title: REQUEST.title, kind: "request", screenshotAttached: false };
  });

  test("reads both reports back from the dashboard: rows, chips, counts, detail rail and a filter", async () => {
    const { bug, request } = filed;
    expect(bug && request, "both reports must have been filed by the two tests before this one").toBeTruthy();
    await page.goto(`${deskOrigin}/feedback`);
    const main = page.locator("#main-content");
    const table = main.getByRole("table", { name: "Feedback reports" });
    const rows = table.locator("tbody tr");
    const row = (ref: string): Locator => table.getByRole("row", { name: new RegExp(ref) });
    await expect(row(bug!.ref)).toBeVisible({ timeout: 30_000 });
    await expect(row(request!.ref)).toBeVisible();

    // Status Open and the right kind chip on each row (ID is column 1, Type 2, Status 8).
    await expect(row(bug!.ref).locator("td:nth-child(8)")).toHaveText("Open");
    await expect(row(request!.ref).locator("td:nth-child(8)")).toHaveText("Open");
    await expect(row(bug!.ref).locator("td:nth-child(2)")).toHaveText("Bug");
    await expect(row(request!.ref).locator("td:nth-child(2)")).toHaveText("Request");

    // The counts row adds up to the rows shown: no filter hides a status by default.
    const countsText = (await main.textContent()) ?? "";
    const counts = /Open (\d+) · In progress (\d+) · Fixed (\d+) · Won't fix (\d+) · Duplicate (\d+)/.exec(countsText);
    expect(counts, "the counts row").not.toBeNull();
    const countsRow = counts![0];
    const total = counts!.slice(1).reduce((sum, value) => sum + Number(value), 0);
    expect(await rows.count()).toBe(total);
    expect(Number(counts![1])).toBeGreaterThanOrEqual(2);
    await expect(main).toContainText(`${total} report${total === 1 ? "" : "s"}`);
    await page.screenshot({ path: `${runDir}/feedback-list.png` });

    // The detail rail for the bug: title, description, expectation, screenshot counter.
    const finding = JSON.parse(readFileSync(`${runDir}/bug-finding.json`, "utf8")) as { title: string; body: string; expected: string };
    await row(bug!.ref).click();
    await expect(page).toHaveURL(/\/feedback\?id=\d+$/);
    const rail = page.getByRole("complementary", { name: "Report details" });
    await expect(rail.getByRole("heading", { name: finding.title })).toBeVisible();
    await expect(rail).toContainText(finding.body);
    await expect(rail).toContainText(finding.expected);
    await expect(rail).toContainText("P2");
    await expect(rail.getByText("Screenshots")).toBeVisible();
    await expect(rail).toContainText("1 of 6");
    await expect(rail.getByRole("link", { name: "View desk-screen-1440x900.png" })).toHaveAttribute("href", /\/api\/desk\/feedback\/attachments\/\d+$/);
    await rail.screenshot({ path: `${runDir}/feedback-detail-rail.png` });

    // A filter changes the list: the search box narrows it to the request, clearing it brings both back.
    const before = await rows.count();
    await main.getByRole("searchbox", { name: "Search reports" }).fill(REQUEST.searchTerm);
    await expect(row(request!.ref)).toBeVisible();
    await expect(row(bug!.ref)).toHaveCount(0);
    const narrowed = await rows.count();
    expect(narrowed).toBeLessThan(before);
    await main.getByRole("searchbox", { name: "Search reports" }).fill("");
    await expect(row(bug!.ref)).toBeVisible();
    await expect(rows).toHaveCount(before);

    writeFileSync(
      `${runDir}/feedback-prod-summary.json`,
      `${JSON.stringify({ bug, request, countsRow, rowsShown: before, rowsAfterSearch: narrowed, searchTerm: REQUEST.searchTerm }, null, 2)}\n`,
    );
  });
});
