import type { Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";
import { test, expect, expectCleanScreen, prepareDesk, openDesk, origin, watchApi } from "./helpers";

// D5 screener and D6 filter editor (02m §c2, §a3.4). The seeds' returned matches (the API caps them at 8 rows) never include
// SPY, NVDA or MSFT, the only symbols with bars, so the chart test saves its own filter; the editor tests save copies of
// the Overbought RSI seed.

type Listed = { id: number; name: string; origin: string; read_only: boolean };
type Detail = {
  id: number;
  name: string;
  version: number;
  spec: Record<string, unknown> & { when: Record<string, unknown>; maxResults: number };
};
type Preview = { matches_total: number | null; scanned: number; top: { symbol: string }[] };

const narrow = () => test.info().project.name === "desktop-1180";

/** At 1180 the right rail is a tab strip: open one of its sections in the drawer. At 1440 every section is shown. */
async function openRailSection(page: Page, name: string) {
  if (narrow()) await page.getByRole("tab", { name }).click();
}

/** The editor's Live matches section: its region at 1440, the drawer once it is open at 1180. */
const liveRegion = (page: Page) =>
  narrow() ? page.getByRole("dialog", { name: "Live matches" }) : page.getByRole("region", { name: "Live matches" });

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${origin}${path}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as T;
}

/** "Save as my filter" over the API: an editable copy of a seed, run once by the real runner. */
async function copyOf(page: Page, id: number): Promise<number> {
  const response = await page.request.post(`${origin}/api/desk/screener/filters`, { data: { copy_of: id } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as Detail).id;
}

/** What the editor's live check returns for the copy's spec with its `when` threshold set to `value`. */
async function previewAt(page: Page, id: number, value: number): Promise<Preview> {
  const detail = await getJson<Detail>(page, `/api/desk/screener/filters/${id}`);
  const spec = { ...detail.spec, when: { ...detail.spec.when, right: { value } } };
  const response = await page.request.post(`${origin}/api/desk/screener/preview`, { data: { spec } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Preview;
}

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

test("the rail lists the ten seed filters; the header, universe line and stamp read right; a rail click switches filters", async ({ page }) => {
  await openDesk(page, "/screener?filter=1");
  await expectCleanScreen(page);
  await page.getByRole("tab", { name: "Filters" }).click();
  // ten read-only seeds under Defaults, the one on screen marked current; her own list is empty
  const defaults = page.getByRole("region", { name: "Defaults" });
  await expect(defaults.getByRole("link")).toHaveCount(10);
  await expect(defaults.getByRole("link", { name: /Abnormal volume/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "My filters" })).toContainText("No saved filters yet");
  // header: name with the read-only mark, the rule in plain English, and the controls
  await expect(page.getByRole("heading", { level: 1, name: "Abnormal volume Read-only" })).toBeVisible();
  await expect(page.getByText("At each 15-minute close during regular hours")).toBeVisible();
  // no Regular|Extended toggle: the API runs the filter's own session, which the rule sentence already states (V-SCR-04)
  await expect(page.getByRole("group", { name: "Session" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View rule" })).toHaveAttribute("href", "/screener/filters?id=1");
  await expect(page.getByRole("button", { name: "Save as my filter" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Alert on this filter" })).toBeVisible();
  // the run's own count and time (never the universe's), its Details disclosure, and the closed-market stamp
  await expect(page.getByText(/^Scanned 131 symbols at 3:45 PM ET Thu 2026-10-15$/)).toBeVisible();
  await page.locator("#main-content").getByText("Details", { exact: true }).click();
  await expect(page.getByText(/^Scan basis: /)).toBeVisible();
  await expect(page.locator("#main-content").getByText(COPY.closed, { exact: true })).toBeVisible();
  // a rail click switches the header, the table and the URL
  await defaults.getByRole("link", { name: /Gap up/ }).click();
  await expect(page).toHaveURL(/\/screener\?filter=3$/);
  await expect(page.getByRole("heading", { level: 1, name: "Gap up Read-only" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Screener matches" }).getByRole("row").nth(1)).toHaveText(/^BEZ/);
  // selection is not in the URL: the new filter's first match is selected
  await expect(page.getByRole("row", { name: /^BEZ/ })).toHaveAttribute("aria-selected", "true");
  await expectCleanScreen(page);
});

test("the defaults show as chips above the table; New filter opens a blank filter that Create filter saves as hers", async ({ page }) => {
  await openDesk(page, "/screener?filter=1");
  const chips = page.getByRole("navigation", { name: "Screener filters" });
  await expect(chips.getByRole("link")).toHaveCount(11); // ten defaults and New filter
  await expect(chips.getByRole("link", { name: /^Abnormal volume/ })).toHaveAttribute("aria-current", "page");
  await chips.getByRole("link", { name: /^Gap up/ }).click();
  await expect(page).toHaveURL(/\/screener\?filter=3$/);
  await expect(page.getByRole("heading", { level: 1, name: "Gap up Read-only" })).toBeVisible();

  await chips.getByRole("link", { name: "New filter" }).click();
  await expect(page).toHaveURL(/\/screener\/filters$/);
  await expect(page.getByRole("heading", { level: 1, name: "New filter" })).toBeVisible();
  await page.getByRole("button", { name: "Create filter" }).click();
  await expect(page).toHaveURL(/\/screener\/filters\?id=\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: "New filter" })).toBeVisible();
  await expectCleanScreen(page);
});

test("the results table lists matches in rank order with the filter's columns; 1180 drops three of them", async ({ page }) => {
  await openDesk(page, "/screener?filter=1");
  await expectCleanScreen(page);
  const table = page.getByRole("table", { name: "Screener matches" });
  await expect(page.getByText("Showing the top 8 of 9 matches")).toBeVisible();
  await expect(table.getByRole("row").nth(1)).toHaveText(/^BOLT/);
  await expect(table.getByRole("row").nth(2)).toHaveText(/^LKQ/);
  await expect(table.getByRole("row").nth(3)).toHaveText(/^SPTI/);
  await expect(table.getByRole("columnheader", { name: "RVOL", exact: true })).toBeVisible();
  // matched_since ("Since"), atr_pct_14 ("ATR %") and volume ("Volume") carry a band priority: gone at 1180 only
  for (const label of ["Since", "ATR %", "Volume"]) {
    const header = table.getByRole("columnheader", { name: label, exact: true });
    if (narrow()) await expect(header).toHaveCount(0);
    else await expect(header).toBeVisible();
  }
});

test("quick filters narrow the rows in place and say so; Clear brings them back (A-SCR-02)", async ({ page }) => {
  await openDesk(page, "/screener?filter=1");
  const quick = page.getByRole("group", { name: "Quick filters" });
  const table = page.getByRole("table", { name: "Screener matches" });
  for (const label of ["Price", "Change %", "Gap %", "Avg volume", "Rel volume", "RSI (14)", "52-week high"]) {
    await expect(quick.getByRole("combobox", { name: label })).toHaveValue("");
  }
  await quick.getByRole("combobox", { name: "RSI (14)" }).selectOption({ label: "Overbought (70+)" });
  await expect(page.getByText(/^\d of 8 rows pass your quick filters · 9 matched the scan$/)).toBeVisible();
  await expect(table.getByRole("row").nth(1)).toHaveText(/^BOLT/); // RSI 79.7
  // a band nothing passes leaves a plain empty state with its own way out
  await quick.getByRole("combobox", { name: "Price" }).selectOption({ label: "$50 and over" });
  await quick.getByRole("combobox", { name: "Change %" }).selectOption({ label: "Down 10% or more" });
  await expect(page.getByText("None of the 8 rows pass your quick filters")).toBeVisible();
  await quick.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Showing the top 8 of 9 matches")).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(9);
  await expectCleanScreen(page);
});

test("selecting a row loads its preview; a symbol without stored bars gets a friendly empty chart", async ({ page }) => {
  const api = watchApi(page);
  await openDesk(page, "/screener?filter=1");
  await openRailSection(page, "Preview");
  // the first row is selected by default; BOLT has no stored bars
  await expect(page.getByRole("row", { name: /^BOLT/ })).toHaveAttribute("aria-selected", "true");
  const bolt = page.getByRole("region", { name: "BOLT 15m market chart" });
  await expect(bolt.getByRole("status")).toHaveText("No closed bars available for this symbol and timeframe.");
  await expect(page.getByText("Couldn't load this chart")).toHaveCount(0);
  expect(api.paths().some((path) => path.startsWith("GET /api/desk/bars/BOLT?"))).toBe(true);
  // another row moves the selection and the preview to its symbol
  await page.getByRole("table", { name: "Screener matches" }).getByRole("cell", { name: "LKQ", exact: true }).click();
  await expect(page.getByRole("row", { name: /^LKQ/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "LKQ 15m market chart" })).toBeVisible();
  expect(api.paths().some((path) => path.startsWith("GET /api/desk/bars/LKQ?"))).toBe(true);
  await expectCleanScreen(page);
});

test("a symbol with stored bars draws its chart in the preview", async ({ page }) => {
  // A saved filter whose rule SPY, NVDA and MSFT pass (RSI above zero), ranked and run on the daily close as the seed is.
  const seed = await getJson<Detail>(page, "/api/desk/screener/filters/8");
  const created = await page.request.post(`${origin}/api/desk/screener/filters`, {
    data: { spec: { ...seed.spec, name: "RSI above zero", when: { op: "gt", left: { series: "rsi", length: 14 }, right: { value: 0 } } } },
  });
  expect(created.ok()).toBeTruthy();
  const id = ((await created.json()) as Detail).id;
  await openDesk(page, `/screener?filter=${id}`);
  await openRailSection(page, "Preview");
  // daily-close filter: the preview is the daily chart of the selected row
  await page.getByRole("table", { name: "Screener matches" }).getByRole("cell", { name: "NVDA", exact: true }).click();
  await expect(page.getByRole("region", { name: "NVDA 1d market chart" }).locator("canvas").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open chart" })).toHaveAttribute("href", "/technicals?symbol=NVDA#chart");
  await expectCleanScreen(page);
});

test("Save as my filter copies a seed into an editable filter, opens it, and the copy's first run shows no matches", async ({ page }) => {
  const api = watchApi(page);
  await openDesk(page, "/screener?filter=1");
  await page.getByRole("button", { name: "Save as my filter" }).click();
  await expect(page).toHaveURL(/\/screener\/filters\?id=\d+$/);
  const id = Number(new URL(page.url()).searchParams.get("id"));
  await expect(page.getByRole("heading", { level: 1, name: "Abnormal volume (copy)" })).toBeVisible();
  await expect(page.getByText("Default filters are read-only")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Name" })).toBeEditable();
  await expectCleanScreen(page);
  expect(api.paths()).toContain("POST /api/desk/screener/filters");
  const listed = await getJson<Listed[]>(page, "/api/desk/screener/filters");
  expect(listed.find((filter) => filter.id === id)).toMatchObject({ name: "Abnormal volume (copy)", origin: "user", read_only: false });
  // the copy has run over the stored universe and matched nothing: the table says so
  await openDesk(page, `/screener?filter=${id}`);
  await expect(page.getByText(COPY.emptyScanNoTime)).toBeVisible();
  await expectCleanScreen(page);
});

test("a default filter opens read-only in the editor: Copy to edit, disabled fields, JSON collapsed", async ({ page }) => {
  await openDesk(page, "/screener/filters?id=1");
  await expectCleanScreen(page);
  await expect(page.getByText("Default filters are read-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy to edit" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "Value" })).toBeDisabled();
  // the live check runs on a seed too: wait for it to finish before the page closes
  await openRailSection(page, "Live matches");
  await expect(liveRegion(page).getByText(/^matches of \d+ symbols?, checked now on stored bars$/)).toBeVisible();
  // the preview names the scheduled run the screener shows, and says why the two counts differ (V-SCR-03)
  await expect(liveRegion(page).getByText("Last scan: 9 of 131 at 3:45 PM ET Thu 2026-10-15")).toBeVisible();
  await expect(liveRegion(page).getByText("The preview and the last scan checked different symbols, so their counts differ.")).toBeVisible();
  // the JSON panel of the spec is closed until opened
  await openRailSection(page, "JSON");
  await expect(page.locator("details", { hasText: "View JSON" })).not.toHaveAttribute("open");
  await page.getByText("View JSON", { exact: true }).click();
  await expect(page.locator("pre").filter({ hasText: '"op": "gte"' })).toBeVisible();
  await expectCleanScreen(page);
});

test("editing a threshold moves the live matches and shows the unsaved bar; Discard restores the saved form", async ({ page }) => {
  const id = await copyOf(page, 8);
  const saved = await previewAt(page, id, 70);
  const edited = await previewAt(page, id, 0);
  expect(edited.matches_total, "the threshold change must move the count").not.toBe(saved.matches_total);
  await openDesk(page, `/screener/filters?id=${id}`);
  await openRailSection(page, "Live matches");
  const live = liveRegion(page);
  await expect(live.getByText(new RegExp(`^matches of ${saved.scanned} symbols?, checked now on stored bars$`))).toBeVisible();
  await page.getByRole("spinbutton", { name: "Value" }).fill("0");
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeVisible();
  // the check follows the edit (500 ms debounce): new count and the top five
  await expect(live.getByText(String(edited.matches_total), { exact: true })).toBeVisible();
  for (const row of edited.top.slice(0, 5)) {
    await expect(live.getByRole("link", { name: row.symbol, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("spinbutton", { name: "Value" })).toHaveValue("70");
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
  await expect(live.getByText(String(saved.matches_total), { exact: true })).toBeVisible();
  await expectCleanScreen(page);
});

test("an invalid value shows its problem with the field path; Discard restores; a fixed Save draft stores a new version", async ({ page }) => {
  const id = await copyOf(page, 8);
  const api = watchApi(page);
  await openDesk(page, `/screener/filters?id=${id}`);
  const maxResults = page.getByRole("spinbutton", { name: "Max results (1 to 100)" });
  const unsaved = page.getByRole("region", { name: "Unsaved changes" });
  await maxResults.fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "1 problem to fix" })).toBeVisible();
  // the message sits by its field, with the field path in muted text
  await expect(page.getByText("maxResults", { exact: true })).toBeVisible();
  await expectCleanScreen(page);
  await unsaved.getByRole("button", { name: "Discard changes" }).click();
  await expect(maxResults).toHaveValue("50");
  await expect(page.getByRole("alert").filter({ hasText: "1 problem to fix" })).toHaveCount(0);
  await expect(unsaved).toHaveCount(0);
  await maxResults.fill("25");
  await unsaved.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  expect(api.paths()).toContain(`PUT /api/desk/screener/filters/${id}`);
  const saved = await getJson<Detail>(page, `/api/desk/screener/filters/${id}`);
  expect(saved.version).toBe(2);
  expect(saved.spec.maxResults).toBe(25);
  await expect(unsaved).toHaveCount(0);
  await expectCleanScreen(page);
});

// "Reset to default" restores the seed's values but keeps the copy's own name, so the form is clean again.
test("Reset to default restores the default values and keeps the copy's name", async ({ page }) => {
  const id = await copyOf(page, 8);
  await openDesk(page, `/screener/filters?id=${id}`);
  await page.getByRole("spinbutton", { name: "Max results (1 to 100)" }).fill("0");
  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect(page.getByRole("spinbutton", { name: "Max results (1 to 100)" })).toHaveValue("50");
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Overbought RSI (copy)");
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
});
