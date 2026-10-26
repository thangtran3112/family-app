import type { Locator, Page } from "@playwright/test";
import { test, expect, prepareDesk, openDesk, expectCleanScreen, watchApi, SEED_NOW } from "./helpers";

// The Feedback log (02s P2): the dashboard with its filters, table and detail rail, the filing form with its screenshots,
// the entry points, and the states the boards draw (empty, loading, error, uploading, upload failed, sent, agent lines).

const isNarrow = () => test.info().project.name === "desktop-1180";

/** A 1x1 PNG: a real image the server's magic-byte check accepts. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const mb = (size: number) => Buffer.alloc(Math.round(size * 1024 * 1024), 1);

type Report = Record<string, unknown>;
const report = (extra: Report = {}): Report => ({
  kind: "bug",
  severity: "P2",
  title: "Day list marks Day 4 done too early",
  body: "On Practice · Day list the Day 4 row turns green while the replay is still running.",
  screen: "Practice · Day list",
  route: "/practice/day?id=5",
  app_version: "desk-2026.10.16",
  context: { day_list_id: 5 },
  captured_at: SEED_NOW,
  links: [],
  attachment_ids: [],
  ...extra,
});

/** File reports through the API, the way the form does, and return their ids. */
async function fileReports(page: Page, reports: Report[]): Promise<number[]> {
  const ids: number[] = [];
  for (const body of reports) {
    const response = await page.request.post("/api/desk/feedback", { data: body });
    expect(response.status()).toBe(201);
    ids.push(((await response.json()) as { id: number }).id);
  }
  return ids;
}

const FOUR: Report[] = [
  report(),
  report({ kind: "request", severity: null, title: "Add a 20-day volume average line", body: "A volume average on the chart would help.", screen: "Technicals", route: "/technicals?symbol=NVDA", context: { symbol: "NVDA" } }),
  report({ title: "Alert list loses the Pattern filter", body: "After a refresh the filter is gone.", screen: "Alerts", route: "/alerts", context: {} }),
  report({ kind: "request", severity: null, title: "Let me sort watchlists by name", body: "Sorting by name would be easier.", screen: "Watchlists", route: "/watchlists", context: {} }),
];

const table = (page: Page) => page.getByRole("table", { name: "Feedback reports" });
const titles = (page: Page) => table(page).locator("tbody tr td:nth-child(3) span[title]");
/** The detail rail: inline at 1440, the 1180 drawer once a row is chosen. */
const rail = (page: Page): Locator => (isNarrow() ? page.getByRole("dialog", { name: "Report" }) : page.getByRole("complementary", { name: "Report details" }));
const form = (page: Page) => page.getByRole("form", { name: "Report a problem" });

/** Holds every request to the staging route until `release()`, so the uploading state can be read. */
async function holdUploads(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/desk/feedback/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await gate;
    return route.fallback();
  });
  return release;
}

test.describe("the dashboard", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

  test("an empty log says so, keeps New report one click away and turns the filters off with the reason", async ({ page }) => {
    await openDesk(page, "/feedback");
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "Feedback", level: 1 })).toBeVisible();
    await expect(main).toContainText("Open 0 · In progress 0 · Fixed 0 · Won't fix 0 · Duplicate 0");
    await expect(main).toContainText("No reports yet · file one when something looks wrong, or when you want something built");
    await expect(main.getByRole("link", { name: "New report" })).toHaveCount(2);
    await expect(main.getByRole("link", { name: "New report" }).first()).toHaveAttribute("href", "/feedback/new?from=%2Ffeedback");
    await expect(main.getByRole("radio", { name: "Bug" })).toBeDisabled();
    await expect(main.getByRole("button", { name: "Open", exact: true })).toBeDisabled();
    await expect(main.getByRole("searchbox", { name: "Search reports" })).toBeDisabled();
    await expect(main).toContainText("Reason: filters turn on once there is a report to filter.");
    await expect(table(page)).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("the list shows every report newest first with the board's columns, counts and footnote", async ({ page }) => {
    await fileReports(page, FOUR);
    await openDesk(page, "/feedback");
    const main = page.locator("#main-content");
    await expect(table(page).getByRole("columnheader")).toHaveText(["ID", "Type", "Title", "Where", "Area", "Reported by", "Updated", "Status"]);
    await expect(titles(page)).toHaveText([
      "Let me sort watchlists by name",
      "Alert list loses the Pattern filter",
      "Add a 20-day volume average line",
      "Day list marks Day 4 done too early",
    ]);
    await expect(table(page).locator("tbody tr td:nth-child(1)")).toHaveText(["F-004", "F-003", "F-002", "F-001"]);
    await expect(table(page).locator("tbody tr td:nth-child(2)")).toHaveText(["Request", "Bug", "Request", "Bug"]);
    await expect(table(page).locator("tbody tr td:nth-child(8)")).toHaveText(["Open", "Open", "Open", "Open"]);
    await expect(table(page).getByRole("row", { name: /F-001/ })).toContainText("/practice/day?id=5");
    await expect(table(page).getByRole("row", { name: /F-001/ })).toContainText("Practice");
    await expect(main).toContainText("Open 4 · In progress 0 · Fixed 0 · Won't fix 0 · Duplicate 0");
    await expect(main).toContainText("4 reports · Hover a row for Open and Copy id · A Fixed report always shows its fix commit or pull request.");
    await expect(main.getByRole("status")).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("a row opens its report in the rail through ?id=, and a link with ?id= opens the same report", async ({ page }) => {
    await fileReports(page, [
      report({ links: [{ label: "Chart screenshot", url: "https://trading.tobytran.dev/practice/day?id=5" }, { url: "https://trading.tobytran.dev/replay" }], expected: "It should stay In progress." }),
      FOUR[1]!,
    ]);
    await openDesk(page, "/feedback");
    if (!isNarrow()) await expect(rail(page)).toContainText("Select a report to see its details");
    await table(page).getByRole("row", { name: /F-001/ }).click();
    await expect(page).toHaveURL(/\/feedback\?id=1$/);
    const detail = rail(page);
    await expect(detail.getByText("F-001", { exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Day list marks Day 4 done too early" })).toBeVisible();
    await expect(detail).toContainText("Reported by");
    await expect(detail).toContainText("/practice/day?id=5");
    await expect(detail).toContainText("P2 · wrong, with a workaround");
    await expect(detail).toContainText("desk-2026.10.16");
    await expect(detail).toContainText("On Practice · Day list the Day 4 row turns green while the replay is still running.");
    await expect(detail).toContainText("It should stay In progress.");
    await expect(detail.getByRole("link", { name: "Chart screenshot" })).toHaveAttribute("href", "https://trading.tobytran.dev/practice/day?id=5");
    await expect(detail.getByRole("link", { name: "Chart screenshot" })).toHaveAttribute("rel", /noopener/);
    await expect(detail.getByRole("list", { name: "Status history" }).getByRole("listitem")).toHaveText([/^Open · \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET$/]);
    await expect(table(page).getByRole("row", { name: /F-001/ })).toHaveAttribute("aria-selected", "true");

    // A request has no severity row, and a pasted link opens it directly.
    await page.goto("/feedback?id=2");
    await expect(page.locator("#main-content")).toBeVisible();
    if (isNarrow()) await page.getByRole("tab", { name: "Report" }).click();
    await expect(rail(page).getByRole("heading", { name: "Add a 20-day volume average line" })).toBeVisible();
    await expect(rail(page)).not.toContainText("Severity");
    await expect(table(page).getByRole("row", { name: /F-002/ })).toHaveAttribute("aria-selected", "true");

    // A report that does not exist says so in plain words.
    await page.goto("/feedback?id=99");
    if (isNarrow()) await page.getByRole("tab", { name: "Report" }).click();
    await expect(rail(page)).toContainText("There is no report F-099 on this Desk.");
    await expectCleanScreen(page);
  });

  test("the Open and Copy id buttons show on a row and Open selects it", async ({ page }) => {
    await fileReports(page, FOUR);
    await openDesk(page, "/feedback");
    const row = table(page).getByRole("row", { name: /F-003/ });
    await row.hover();
    await expect(row.getByRole("button", { name: "Copy id F-003" })).toBeVisible();
    await row.getByRole("button", { name: "Open F-003" }).click();
    await expect(page).toHaveURL(/\/feedback\?id=3$/);
    await expect(rail(page).getByRole("heading", { name: "Alert list loses the Pattern filter" })).toBeVisible();
  });

  test("type, status, area, search and sort each send their parameter and change the rows", async ({ page }) => {
    await fileReports(page, FOUR);
    const api = watchApi(page);
    await openDesk(page, "/feedback");
    const main = page.locator("#main-content");
    const listRequest = (check: (params: URLSearchParams) => boolean) =>
      page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === "/api/desk/feedback" && check(url.searchParams);
      });

    const bugs = listRequest((params) => params.get("kind") === "bug");
    await main.getByRole("radio", { name: "Bug" }).click();
    await bugs;
    await expect(titles(page)).toHaveText(["Alert list loses the Pattern filter", "Day list marks Day 4 done too early"]);
    const requests = listRequest((params) => params.get("kind") === "request");
    await main.getByRole("radio", { name: "Feature request" }).click();
    await requests;
    await expect(titles(page)).toHaveText(["Let me sort watchlists by name", "Add a 20-day volume average line"]);
    await main.getByRole("radio", { name: "All" }).click();
    await expect(titles(page)).toHaveCount(4);

    const practice = listRequest((params) => params.get("area") === "practice");
    await main.getByRole("combobox", { name: "Area" }).selectOption({ label: "Area · Practice" });
    await practice;
    await expect(titles(page)).toHaveText(["Day list marks Day 4 done too early"]);
    await expect(main).toContainText("1 of 4 reports");
    await main.getByRole("combobox", { name: "Area" }).selectOption({ label: "Area · All" });

    const search = listRequest((params) => params.get("q") === "volume");
    await main.getByRole("searchbox", { name: "Search reports" }).fill("volume");
    await search;
    await expect(titles(page)).toHaveText(["Add a 20-day volume average line"]);
    await main.getByRole("searchbox", { name: "Search reports" }).fill("");
    await expect(titles(page)).toHaveCount(4);

    const oldest = listRequest((params) => params.get("sort") === "oldest");
    await main.getByRole("radio", { name: "Oldest" }).click();
    await oldest;
    await expect(table(page).locator("tbody tr td:nth-child(1)")).toHaveText(["F-001", "F-002", "F-003", "F-004"]);
    await main.getByRole("radio", { name: "Recently updated" }).click();
    await expect(main.getByRole("radio", { name: "Recently updated" })).toBeChecked();

    // Every report is open, so turning Open off leaves nothing, and Clear filters brings the list back.
    const statuses = listRequest((params) => params.getAll("status").join(",") === "in_progress,fixed,wont_fix,duplicate");
    await main.getByRole("button", { name: "Open", exact: true }).click();
    await statuses;
    await expect(main.getByRole("button", { name: "Open", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(main).toContainText("No reports match these filters");
    await main.getByRole("button", { name: "Clear filters" }).click();
    await expect(titles(page)).toHaveCount(4);
    await expect(main.getByRole("button", { name: "Open", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByRole("searchbox", { name: "Search reports" })).toHaveValue("");
    expect(api.paths().filter((path) => !path.startsWith("GET "))).toEqual([]);
    await expectCleanScreen(page);
  });

  test("a failed load says so in plain words and Try again loads the list", async ({ page }) => {
    await fileReports(page, FOUR.slice(0, 1));
    // Only the list request (`/api/desk/feedback?...`), not a report's own route.
    const listUrl = /\/api\/desk\/feedback\?/;
    await page.route(listUrl, async (route) => {
      await route.abort();
      await page.unroute(listUrl);
    });
    await openDesk(page, "/feedback");
    const alert = page.locator("#main-content").getByRole("alert");
    await expect(alert).toContainText("Couldn't load this report list");
    await expectCleanScreen(page);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(titles(page)).toHaveText(["Day list marks Day 4 done too early"]);
    await expect(alert).toHaveCount(0);
  });

  test("the list reads Loading reports while the first answer is on its way", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/desk\/feedback\?/, async (route) => {
      await gate;
      await route.fallback();
    });
    await openDesk(page, "/feedback");
    await expect(page.locator("#main-content").getByRole("status")).toContainText("Loading reports…");
    release();
    await expect(page.locator("#main-content")).toContainText("No reports yet");
  });

  test("the rail shows what an agent is doing: working on it, then fixed with the commit", async ({ page }) => {
    const [id] = await fileReports(page, [report({ title: "Alert list loses the Pattern filter", route: "/alerts" })]);
    const base = {
      id,
      ref: "F-001",
      kind: "bug",
      severity: "P2",
      title: "Alert list loses the Pattern filter",
      route: "/alerts",
      area: "alerts",
      reported_by: "W",
      body: "After a refresh the filter is gone.",
      expected: null,
      screen: "Alerts",
      app_version: "desk-2026.10.16",
      context: {},
      captured_at: "2026-10-15T23:00:00Z",
      links: [],
      attachments: [],
      duplicate_of: null,
    };
    const opened = { at: "2026-10-15T23:00:00Z", actor: "user", from_status: null, to_status: "open", note: null };
    // The browser's clock is the seed clock (Thu 2026-10-15 20:00 ET), so "2 h ago" is 18:00 ET.
    const working = {
      ...base,
      status: "in_progress",
      fix_ref: null,
      updated_at: "2026-10-15T22:00:00Z",
      events: [opened, { at: "2026-10-15T22:00:00Z", actor: "claude-code", from_status: "open", to_status: "in_progress", note: null }],
    };
    const fixed = {
      ...base,
      status: "fixed",
      fix_ref: "1a2b3c4",
      updated_at: "2026-10-15T23:30:00Z",
      events: [...working.events, { at: "2026-10-15T23:30:00Z", actor: "claude-code", from_status: "in_progress", to_status: "fixed", note: "1a2b3c4" }],
    };
    let answer: unknown = working;
    await page.route(`**/api/desk/feedback/${id}`, (route) => route.fulfill({ json: answer }));
    await openDesk(page, `/feedback?id=${id}`);
    if (isNarrow()) await page.getByRole("tab", { name: "Report" }).click();
    const detail = rail(page);
    await expect(detail.getByText("Claude Code is working on this · updated 2 h ago")).toBeVisible();
    await expect(detail.getByText("picked up by Claude Code")).toBeVisible();
    await expect(detail.getByText("In progress", { exact: true })).toBeVisible();
    await expectCleanScreen(page);

    answer = fixed;
    await page.goto(`/feedback?id=${id}`);
    if (isNarrow()) await page.getByRole("tab", { name: "Report" }).click();
    await expect(detail.getByText("Fixed in 1a2b3c4 · shipped Thu 2026-10-15")).toBeVisible();
    await expect(detail.getByText("Claude Code · commit 1a2b3c4")).toBeVisible();
    await expect(detail.getByRole("list", { name: "Status history" }).getByRole("listitem")).toHaveCount(3);
    await expect(detail.getByText("Fixed", { exact: true }).first()).toBeVisible();
    await expectCleanScreen(page);
  });

  test("when the owner moves a report, the table, the counts and the timeline show it", async ({ page }) => {
    const [id] = await fileReports(page, FOUR.slice(0, 2));
    const started = await page.request.patch(`/api/desk/feedback/${id}`, { data: { status: "in_progress" } });
    test.skip(started.status() === 403, "this run's principal is not in DESK_OWNER_EMAILS, so it cannot move a status");
    expect(started.ok()).toBeTruthy();
    expect((await page.request.patch(`/api/desk/feedback/${id}`, { data: { status: "fixed", fix_ref: "1a2b3c4" } })).ok()).toBeTruthy();
    await openDesk(page, `/feedback?id=${id}`);
    await expect(page.locator("#main-content")).toContainText("Open 1 · In progress 0 · Fixed 1 · Won't fix 0 · Duplicate 0");
    await expect(table(page).getByRole("row", { name: /F-001/ }).locator("td:nth-child(8)")).toHaveText("Fixed");
    if (isNarrow()) await page.getByRole("tab", { name: "Report" }).click();
    await expect(rail(page).getByText(/^Fixed in 1a2b3c4 · shipped /)).toBeVisible();
    await expect(rail(page)).toContainText("commit 1a2b3c4");
    await expectCleanScreen(page);
  });
});

test.describe("the filing form", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

  test("opened from the Practice day list it shows where she was, and Send says why it is off", async ({ page }) => {
    await openDesk(page, "/feedback/new?from=%2Fpractice%2Fday%3Fid%3D5");
    await expect(page).toHaveTitle("Report a problem - Family Desk");
    const send = page.getByRole("button", { name: "Send report" });
    await expect(page.getByRole("radio", { name: "Bug" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "P2" })).toBeChecked();
    const where = page.getByRole("region", { name: "Where were you?" });
    await expect(where).toContainText("Practice · Day list");
    await expect(where).toContainText("/practice/day?id=5");
    await expect(where).toContainText("Day list 5");
    await expect(where).toContainText(/desk-/);
    await expect(where.getByRole("combobox", { name: "Which screen?" })).toHaveValue("Practice · Day list");
    await expect(send).toBeDisabled();
    await expect(form(page)).toContainText("Reason: a title and a description are required.");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Day list marks Day 4 done");
    await expect(form(page)).toContainText("Reason: a description is required.");
    await expect(page.getByText("25 / 120")).toBeVisible();
    await page.getByRole("textbox", { name: "What happened?" }).fill("It turns green too early.");
    await expect(send).toBeEnabled();
    await expect(form(page)).toContainText("Ready · every required field is filled and nothing is uploading.");
    await expect(form(page)).toContainText("Nothing is sent anywhere else · the report stays on this Desk");
    await expectCleanScreen(page);
  });

  test("a feature request relabels the description and drops the bug-only fields", async ({ page }) => {
    await openDesk(page, "/feedback/new");
    await expect(page.getByRole("textbox", { name: "What happened?" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "What did you expect?" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Severity" })).toBeVisible();
    await page.getByRole("radio", { name: "Feature request" }).click();
    await expect(page.getByRole("textbox", { name: "What should it do?" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "What happened?" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "What did you expect?" })).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Severity" })).toHaveCount(0);
    await page.getByRole("radio", { name: "Bug" }).click();
    await expect(page.getByRole("radiogroup", { name: "Severity" })).toBeVisible();
    for (const meaning of ["Wrong money or data, a trading figure shown as true, or a secret leak", "A core flow is broken and there is no workaround", "Wrong or confusing, with a workaround", "Cosmetic or copy"]) {
      await expect(page.getByRole("radiogroup", { name: "Severity" })).toContainText(meaning);
    }
  });

  test("filing a bug with a screenshot shows the upload, then the sent state with the new id, and the API has the report", async ({ page }) => {
    const release = await holdUploads(page);
    await openDesk(page, "/feedback/new?from=%2Fpractice%2Fday%3Fid%3D5");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Day list marks Day 4 done");
    await page.getByRole("textbox", { name: "What happened?" }).fill("It turns green too early.");
    await page.getByRole("textbox", { name: "What did you expect?" }).fill("It should stay In progress.");
    await page.getByRole("radio", { name: "P1" }).check();
    await page.getByRole("textbox", { name: "Link 1 label" }).fill("Chart screenshot");
    await page.getByRole("textbox", { name: "Link 1 address" }).fill("https://trading.tobytran.dev/practice/day?id=5");
    await page.getByLabel("Choose screenshots").setInputFiles({ name: "day-list.png", mimeType: "image/png", buffer: PNG });

    const send = page.getByRole("button", { name: "Send report" });
    await expect(page.getByRole("progressbar", { name: "Uploading day-list.png" })).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(form(page)).toContainText("Reason: 1 screenshot is still uploading · you can send when it finishes.");
    await expect(page.getByText("1 of 6")).toBeVisible();
    await expectCleanScreen(page);

    release();
    await expect(page.getByText(/· PNG · uploaded/)).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(page.getByText("1 of 6")).toBeVisible();
    await send.click();

    await expect(page.getByRole("heading", { name: "F-001" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Sent · thanks, it's on the Desk's list" })).toBeVisible();
    const sent = page.getByRole("region", { name: "F-001" });
    await expect(sent).toContainText("Practice · Day list");
    await expect(sent).toContainText("/practice/day?id=5");
    await expect(sent).toContainText("Day list 5");
    await expect(sent).toContainText("1 link · 1 screenshot");
    await expectCleanScreen(page);

    const saved = (await (await page.request.get("/api/desk/feedback/1")).json()) as Record<string, unknown> & { attachments: unknown[]; links: unknown[] };
    expect(saved).toMatchObject({
      ref: "F-001",
      kind: "bug",
      severity: "P1",
      title: "Day list marks Day 4 done",
      expected: "It should stay In progress.",
      screen: "Practice · Day list",
      route: "/practice/day?id=5",
      status: "open",
      context: { day_list_id: 5 },
      links: [{ label: "Chart screenshot", url: "https://trading.tobytran.dev/practice/day?id=5" }],
    });
    expect(saved.attachments).toHaveLength(1);

    await page.getByRole("link", { name: "View it" }).click();
    await expect(page).toHaveURL(/\/feedback\?id=1$/);
    if (isNarrow()) await page.getByRole("tab", { name: "Report" }).click();
    await expect(rail(page).getByRole("heading", { name: "Day list marks Day 4 done" })).toBeVisible();
    await expect(rail(page).getByRole("link", { name: "View day-list.png" })).toHaveAttribute("href", /\/api\/desk\/feedback\/attachments\/\d+$/);
    await expect(rail(page)).toContainText("1 of 6");
  });

  test("filing a feature request with no screenshot sends no severity and no expectation", async ({ page }) => {
    await openDesk(page, "/feedback/new?from=%2Ftechnicals%3Fsymbol%3Dnvda");
    await expect(page.getByRole("region", { name: "Where were you?" })).toContainText("NVDA");
    await page.getByRole("radio", { name: "Feature request" }).click();
    await page.getByRole("textbox", { name: /^Title/ }).fill("Add a 20-day volume average line");
    await page.getByRole("textbox", { name: "What should it do?" }).fill("Show it under the price.");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByRole("heading", { name: "F-001" })).toBeVisible();
    await expect(page.getByRole("region", { name: "F-001" })).toContainText("0 links · 0 screenshots");
    const saved = (await (await page.request.get("/api/desk/feedback/1")).json()) as Record<string, unknown>;
    expect(saved).toMatchObject({ kind: "request", severity: null, expected: null, screen: "Technicals", route: "/technicals?symbol=nvda", context: { symbol: "NVDA" }, attachments: [], links: [] });
    await expectCleanScreen(page);
  });

  test("the screen can be corrected, and the correction travels with the report", async ({ page }) => {
    await openDesk(page, "/feedback/new?from=%2Falerts");
    await page.getByRole("combobox", { name: "Which screen?" }).selectOption("Watchlists");
    await page.getByRole("textbox", { name: /^Title/ }).fill("The wrong list opens");
    await page.getByRole("textbox", { name: "What happened?" }).fill("It opens the first list.");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByRole("heading", { name: "F-001" })).toBeVisible();
    const saved = (await (await page.request.get("/api/desk/feedback/1")).json()) as Record<string, unknown>;
    expect(saved).toMatchObject({ screen: "Watchlists", route: "/alerts", context: { screen_changed_from: "Alerts" } });
  });

  test("a file over 5 MB fails with the words and the limit; removing it frees Send", async ({ page }) => {
    const api = watchApi(page);
    await openDesk(page, "/feedback/new");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Chart looks wrong");
    await page.getByRole("textbox", { name: "What happened?" }).fill("The weekly bars overlap.");
    await page.getByLabel("Choose screenshots").setInputFiles({ name: "weekly-chart.png", mimeType: "image/png", buffer: mb(8.4) });
    const row = page.getByRole("listitem").filter({ hasText: "weekly-chart.png" });
    await expect(row.getByText("Upload failed", { exact: true })).toBeVisible();
    await expect(row.getByRole("alert")).toHaveText("Upload failed · this file is 8.4 MB, the limit is 5 MB");
    await expect(row).toContainText("8.4 MB · PNG");
    await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(row).toContainText("Retry sends the same file again · remove it and add a smaller one to fix this.");
    await expect(page.getByRole("button", { name: "Send report" })).toBeDisabled();
    await expect(form(page)).toContainText("Reason: 1 screenshot failed to upload · retry or remove it.");
    // The failure is the semantic down colour and always has the words (never colour alone).
    expect(await row.getByRole("alert").evaluate((node) => getComputedStyle(node).color)).toBe("rgb(255, 69, 58)");
    // The file never left the browser: it was too big to try.
    expect(api.paths().filter((path) => path.startsWith("POST /api/desk/feedback/attachments"))).toEqual([]);
    await expectCleanScreen(page);

    await row.getByRole("button", { name: "Retry" }).click();
    await expect(row.getByRole("alert")).toHaveText("Upload failed · this file is 8.4 MB, the limit is 5 MB");
    await row.getByRole("button", { name: "Remove weekly-chart.png" }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send report" })).toBeEnabled();
    await expect(page.getByText("0 of 6")).toBeVisible();
  });

  test("a file the server refuses (not a real image) fails with the server's reason, and Retry tries it again", async ({ page }) => {
    const api = watchApi(page);
    await openDesk(page, "/feedback/new");
    await page.getByLabel("Choose screenshots").setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("this is text, not a picture") });
    const row = page.getByRole("listitem").filter({ hasText: "notes.png" });
    await expect(row.getByRole("alert")).toHaveText("Upload failed · only PNG, JPEG or WebP screenshots can be attached");
    expect(api.paths().filter((path) => path === "POST /api/desk/feedback/attachments")).toHaveLength(1);
    await row.getByRole("button", { name: "Retry" }).click();
    await expect(row.getByRole("alert")).toHaveText("Upload failed · only PNG, JPEG or WebP screenshots can be attached");
    expect(api.paths().filter((path) => path === "POST /api/desk/feedback/attachments")).toHaveLength(2);
    await expectCleanScreen(page);
  });

  test("a screenshot can be dropped or pasted, a cancelled upload leaves nothing behind, and six is the most", async ({ page }) => {
    await holdUploads(page); // the first upload stays open until it is cancelled; the route is then removed
    await openDesk(page, "/feedback/new");
    const png = PNG.toString("base64");
    const makeTransfer = (name: string) =>
      page.evaluateHandle(
        ({ data, name }) => {
          const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], name, { type: "image/png" }));
          return transfer;
        },
        { data: png, name },
      );

    await page.getByRole("button", { name: /Drop a screenshot here/ }).dispatchEvent("drop", { dataTransfer: await makeTransfer("dropped.png") });
    await expect(page.getByRole("progressbar", { name: "Uploading dropped.png" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel upload of dropped.png" }).click();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.getByText("0 of 6")).toBeVisible();

    await page.unroute("**/api/desk/feedback/attachments");
    const transfer = await makeTransfer("pasted.png");
    await page.evaluate((data) => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true })), transfer);
    await expect(page.getByText(/pasted\.png/)).toBeVisible();
    await expect(page.getByText(/· PNG · uploaded/)).toBeVisible();

    await page
      .getByLabel("Choose screenshots")
      .setInputFiles([1, 2, 3, 4, 5].map((index) => ({ name: `shot-${index}.png`, mimeType: "image/png", buffer: PNG })));
    await expect(page.getByText("6 of 6")).toBeVisible();
    await expect(page.getByRole("button", { name: /That is the most a report can hold/ })).toBeDisabled();
    await expect(page.getByText(/· PNG · uploaded/)).toHaveCount(6);
    await expectCleanScreen(page);
  });

  test("removing an uploaded screenshot deletes it on the server, and the row, the counter and Send follow", async ({ page }) => {
    const api = watchApi(page);
    await openDesk(page, "/feedback/new");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Chart looks wrong");
    await page.getByRole("textbox", { name: "What happened?" }).fill("The weekly bars overlap.");
    const uploaded = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/desk/feedback/attachments"));
    await page.getByLabel("Choose screenshots").setInputFiles({ name: "day-list.png", mimeType: "image/png", buffer: PNG });
    const { id } = (await (await uploaded).json()) as { id: number };
    const row = page.getByRole("listitem").filter({ hasText: "day-list.png" });
    await expect(row.getByText(/· PNG · uploaded/)).toBeVisible();
    await expect(page.getByText("1 of 6")).toBeVisible();

    await row.getByRole("button", { name: "Remove day-list.png" }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText("0 of 6")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send report" })).toBeEnabled();
    expect(api.paths().filter((path) => path.startsWith("DELETE"))).toEqual([`DELETE /api/desk/feedback/attachments/${id}`]);
    await expectCleanScreen(page);
  });

  test("a refused removal keeps the screenshot and says why in plain words", async ({ page }) => {
    await page.route("**/api/desk/feedback/attachments/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      return route.fulfill({ status: 409, json: { detail: "This file is already on a report." } });
    });
    await openDesk(page, "/feedback/new");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Chart looks wrong");
    await page.getByRole("textbox", { name: "What happened?" }).fill("The weekly bars overlap.");
    await page.getByLabel("Choose screenshots").setInputFiles({ name: "day-list.png", mimeType: "image/png", buffer: PNG });
    const row = page.getByRole("listitem").filter({ hasText: "day-list.png" });
    await expect(row.getByText(/· PNG · uploaded/)).toBeVisible();

    await row.getByRole("button", { name: "Remove day-list.png" }).click();
    await expect(row.getByRole("alert")).toHaveText("Could not remove this screenshot · it is already on a report and stays with it");
    await expect(row).toHaveCount(1);
    await expect(page.getByText("1 of 6")).toBeVisible();
    await expectCleanScreen(page);
  });

  test("a link without a web address blocks Send with the reason, and links can be added and removed", async ({ page }) => {
    await openDesk(page, "/feedback/new");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Wrong colour");
    await page.getByRole("textbox", { name: "What happened?" }).fill("The chip is the wrong colour.");
    await page.getByRole("textbox", { name: "Link 1 address" }).fill("not a link");
    await expect(page.getByRole("button", { name: "Send report" })).toBeDisabled();
    await expect(form(page)).toContainText("Reason: link 1 needs a web address that starts with http:// or https://.");
    await expect(page.getByRole("alert").filter({ hasText: "A link needs a web address" })).toBeVisible();
    await page.getByRole("button", { name: "+ Add link" }).click();
    await expect(page.getByRole("textbox", { name: "Link 2 address" })).toBeVisible();
    await page.getByRole("button", { name: "Remove link 1" }).click();
    await expect(page.getByRole("textbox", { name: "Link 2 address" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Link 1 address" })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Send report" })).toBeEnabled();
  });

  test("a refused Send says why in plain words and keeps what she wrote", async ({ page }) => {
    await page.route("**/api/desk/feedback", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({ status: 500, json: { detail: "boom" } });
    });
    await openDesk(page, "/feedback/new");
    await page.getByRole("textbox", { name: /^Title/ }).fill("Wrong colour");
    await page.getByRole("textbox", { name: "What happened?" }).fill("The chip is the wrong colour.");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(form(page).getByRole("alert")).toHaveText("Couldn't send the report · Try again");
    await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Wrong colour");
    await expect(page.getByRole("button", { name: "Send report" })).toBeEnabled();
    await expectCleanScreen(page);
  });

  test("Cancel returns to the screen she came from", async ({ page }) => {
    await openDesk(page, "/feedback/new?from=%2Falerts");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/alerts$/);
  });

  test("the right rail explains the three steps and lists what was attached automatically", async ({ page }) => {
    await openDesk(page, "/feedback/new?from=%2Falerts");
    if (isNarrow()) await page.getByRole("tab", { name: "How this works" }).click();
    const how = isNarrow() ? page.getByRole("dialog", { name: "How this works" }) : page.getByRole("complementary", { name: "About this report" });
    await expect(how).toContainText("File it");
    await expect(how).toContainText("Hermes and Claude Code pick it up");
    await expect(how).toContainText("The report shows the fix");
    await expect(how).toContainText("Attached automatically");
    await expect(how).toContainText("/alerts");
  });
});

test.describe("the entry points", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

  test("the avatar menu opens Feedback, and the Settings & More rail lists it as the selected section", async ({ page }) => {
    await openDesk(page, "/settings");
    const rail = page.getByRole("complementary", { name: "Settings and More" });
    await expect(rail.getByRole("link")).toHaveText(["Defaults", "Alert channels", "Data sources", "Brokers", "Strategies", "Feedback"]);
    await expect(rail.getByRole("link", { name: "Defaults" })).toHaveAttribute("aria-current", "page");
    await page.locator(".dk-top").getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menu", { name: "Account" }).getByRole("menuitem")).toHaveText(["Settings", "More", "Feedback"]);
    await page.getByRole("menuitem", { name: "Feedback" }).click();
    await expect(page).toHaveURL(/\/feedback$/);
    await expect(page.locator("#main-content").getByRole("heading", { name: "Feedback", level: 1 })).toBeVisible();
    const feedbackRail = page.getByRole("complementary", { name: "Settings and More" });
    await expect(feedbackRail.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
    await feedbackRail.getByRole("link", { name: "Brokers" }).click();
    await expect(page).toHaveURL(/\/settings#settings-trading$/);
    await expect(page.getByRole("complementary", { name: "Settings and More" }).getByRole("link", { name: "Brokers" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("complementary", { name: "Settings and More" }).getByRole("link", { name: "Feedback" }).click();
    await expect(page).toHaveURL(/\/feedback$/);
    await expectCleanScreen(page);
  });

  test("the status bar link opens the form with the screen she was on", async ({ page }) => {
    await openDesk(page, "/technicals?symbol=NVDA#chart");
    const footer = page.getByRole("contentinfo", { name: "Status" });
    await expect(footer.getByRole("link", { name: "Report a problem" })).toBeVisible();
    await footer.getByRole("link", { name: "Report a problem" }).click();
    await expect(page).toHaveURL(/\/feedback\/new\?from=%2Ftechnicals%3Fsymbol%3DNVDA$/);
    const where = page.getByRole("region", { name: "Where were you?" });
    await expect(where).toContainText("Technicals");
    await expect(where).toContainText("/technicals?symbol=NVDA");
    await expect(where).toContainText("NVDA");
    await expect(page.getByRole("contentinfo", { name: "Status" })).toContainText("Feedback stays on this Desk · nothing is sent to a third-party tracker");
    await expectCleanScreen(page);
  });

  test("every screen carries the link, the Practice screens included", async ({ page }) => {
    for (const path of ["/", "/alerts", "/practice", "/feedback"]) {
      await openDesk(page, path);
      await expect(page.getByRole("contentinfo", { name: "Status" }).getByRole("link", { name: "Report a problem" })).toBeVisible();
    }
  });
});
