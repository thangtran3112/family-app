import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, prepareDesk, openDesk, origin, watchApi, expectCleanScreen } from "./helpers";

// The strategy library (D8, 02m §a3.6 and c2): categories, presets, preview and "Attach to list". Attach writes an
// alert-only strategy, which starts as a draft while the alert runtime flag is off.

type StrategyRow = { name: string; origin: string; stage: string; status: string; source: { label: string }; spec: Record<string, unknown> };

const LIBRARY = "/strategies/library";
const ATTACH_DAY_MOVERS = "Attach to Day movers · alert only";
const ATTACHED_DAY_MOVERS = "Attached to Day movers as a draft · alerts start when live quotes are connected";

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

/** The preset rows: the list without the category nav's "All presets" button (the preview's lists hold no buttons). */
function presetRows(page: Page) {
  return page.getByRole("list").filter({ hasNot: page.getByRole("button", { name: /^All presets/ }) }).getByRole("button");
}

/** Every strategy the user has, from the API the Alerts screen reads. */
async function strategies(context: BrowserContext): Promise<StrategyRow[]> {
  const response = await context.request.get(`${origin}/api/desk/alert-strategies`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as StrategyRow[];
}

/** The strategies a library attach wrote for the Hammer preset. */
async function hammerStrategies(context: BrowserContext): Promise<StrategyRow[]> {
  return (await strategies(context)).filter((row) => row.origin === "library" && row.name === "Hammer");
}

test("the library lists the technical presets by category, with the attach target and the v1 footnote", async ({ page }) => {
  await openDesk(page, LIBRARY);
  await expectCleanScreen(page);
  const categories = page.getByRole("navigation", { name: "Preset categories" });
  for (const name of ["All presets 37", "Candlesticks 20", "Breakouts 5", "Trend 9", "Volume 2", "Futures 1"]) {
    await expect(categories.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(presetRows(page)).toHaveCount(37);
  // Filter-kind presets live in the screener, so a filter such as Gap up is not in this list.
  await expect(page.getByRole("button", { name: /^Gap up/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Attach to list" })).toBeVisible();
  await expect(page.getByRole("button", { name: ATTACH_DAY_MOVERS })).toBeVisible();
  await expect(page.getByText("Pattern rules are fixed in v1")).toBeVisible();
  // The first preset's preview loads with the screen; wait for it so the test ends with no request in flight.
  await expect(page.getByRole("article").getByRole("heading", { name: "In plain English" })).toBeVisible();
});

test("search narrows the list, a nonsense query shows the empty state, and clearing restores it", async ({ page }) => {
  await openDesk(page, LIBRARY);
  const search = page.getByRole("searchbox", { name: "Search presets" });
  await search.fill("Hammer");
  await expect(presetRows(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Inverted hammer/ })).toBeVisible();
  await search.fill("zzqx");
  await expect(page.getByText("No presets match “zzqx”")).toBeVisible();
  await expectCleanScreen(page);
  await search.clear();
  await expect(presetRows(page)).toHaveCount(37);
  await expect(page.getByRole("article").getByRole("heading", { name: "In plain English" })).toBeVisible();
});

test("selecting Hammer shows its plain-English sentence, WHEN, defaults, a real example and the Attach button", async ({ page, context }) => {
  // The example is read from the API first: the seed has MSFT bars, so the screen must show that occurrence.
  const detail = (await (await context.request.get(`${origin}/api/desk/library/hammer`)).json()) as {
    example: { symbol: string; timeframe: string } | null;
  };
  expect(detail.example).not.toBeNull();
  await openDesk(page, LIBRARY);
  await page.getByRole("button", { name: /^Hammer / }).click();
  const preview = page.getByRole("article");
  await expect(preview.getByRole("heading", { name: "Hammer", level: 2 })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "In plain English" })).toBeVisible();
  await expect(preview.getByText("At each 15-minute close during regular hours, alert when a hammer pattern appears after a downtrend over 5 bars; notify inbox.")).toBeVisible();
  await expect(preview.getByRole("heading", { name: "When" })).toBeVisible();
  await expect(preview.getByText("a hammer pattern appears after a downtrend over 5 bars", { exact: true })).toBeVisible();
  await expect(preview.getByRole("listitem").filter({ hasText: /^Severity: opportunity$/ })).toBeVisible();
  await expect(preview.getByRole("listitem").filter({ hasText: /^Channels: Inbox$/ })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Real example" })).toBeVisible();
  await expect(preview.getByRole("figure")).toContainText(`Hammer on ${detail.example?.symbol} · ${detail.example?.timeframe} · `);
  await expectCleanScreen(page);
  // Both panes and the Attach button are on screen at this band: the list, the preview, the button enabled.
  await expect(page.getByRole("searchbox", { name: "Search presets" })).toBeVisible();
  await expect(page.getByRole("button", { name: ATTACH_DAY_MOVERS })).toBeVisible();
  await expect(page.getByRole("button", { name: ATTACH_DAY_MOVERS })).toBeEnabled();
});

test("attaching Hammer to Day movers writes a draft strategy that Alerts lists as Draft", async ({ page, context }) => {
  const api = watchApi(page);
  await openDesk(page, LIBRARY);
  await page.getByRole("button", { name: /^Hammer / }).click();
  await page.getByRole("button", { name: ATTACH_DAY_MOVERS }).click();
  await expect(page.getByText(ATTACHED_DAY_MOVERS)).toBeVisible();
  await expectCleanScreen(page);
  expect(api.paths()).toContain("POST /api/desk/library/hammer/attach");
  // The runtime flag is off, so the strategy is a draft on Day movers, and it carries no paper order.
  const created = await hammerStrategies(context);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ name: "Hammer", stage: "draft", status: "draft", source: { label: "Day movers" } });
  expect(JSON.stringify(created[0]?.spec)).not.toContain("paperOrder");
  await page.getByRole("link", { name: "Open alerts" }).click();
  await expect(page.getByRole("heading", { name: "Alerts", level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Hammer Day movers / })).toContainText("Draft");
  await expectCleanScreen(page);
});

test("attaching the same preset to the same list again keeps one strategy", async ({ page, context }) => {
  const responses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/desk/library/hammer/attach")) responses.push(response.status());
  });
  await openDesk(page, LIBRARY);
  await page.getByRole("button", { name: /^Hammer / }).click();
  const attach = page.getByRole("button", { name: ATTACH_DAY_MOVERS });
  await attach.click();
  await expect(page.getByText(ATTACHED_DAY_MOVERS)).toBeVisible();
  const before = (await hammerStrategies(context)).length;
  await attach.click();
  // The second attach answers 200 with the strategy the first one wrote. The screen repeats the same result: there is no separate "already attached" state.
  await expect.poll(() => responses.length).toBe(2);
  expect(responses).toEqual([201, 200]);
  await expect(attach).toBeEnabled();
  await expect(page.getByText(ATTACHED_DAY_MOVERS)).toBeVisible();
  expect(await hammerStrategies(context)).toHaveLength(before);
  await expectCleanScreen(page);
});

test("attaching Hammer to Swing creates a second strategy beside the Day movers one", async ({ page, context }) => {
  await openDesk(page, LIBRARY);
  await page.getByRole("button", { name: /^Hammer / }).click();
  await page.getByRole("button", { name: ATTACH_DAY_MOVERS }).click();
  await expect(page.getByText(ATTACHED_DAY_MOVERS)).toBeVisible();
  await page.getByRole("combobox", { name: "Attach to list" }).selectOption({ label: "Swing" });
  await page.getByRole("button", { name: "Attach to Swing · alert only" }).click();
  await expect(page.getByText("Attached to Swing as a draft · alerts start when live quotes are connected")).toBeVisible();
  await expectCleanScreen(page);
  const sources = (await hammerStrategies(context)).map((row) => row.source.label);
  expect(sources.sort()).toEqual(["Day movers", "Swing"]);
});

test("the futures preset is listed, but its attach is disabled with the reason", async ({ page }) => {
  await openDesk(page, LIBRARY);
  await page.getByRole("navigation", { name: "Preset categories" }).getByRole("button", { name: "Futures 1", exact: true }).click();
  await expect(presetRows(page)).toHaveCount(1);
  await page.getByRole("button", { name: /^Futures overnight-range break/ }).click();
  await expect(page.getByRole("article").getByRole("heading", { name: "Futures overnight-range break", level: 2 })).toBeVisible();
  await expect(page.getByRole("note")).toHaveText("Futures alerts start when IBKR quotes connect");
  await expect(page.getByRole("button", { name: ATTACH_DAY_MOVERS })).toBeDisabled();
  await expectCleanScreen(page);
});

test("when the library cannot load, the screen says so and Try again loads the presets", async ({ page }) => {
  await page.route("**/api/desk/library**", (route) => route.abort());
  await openDesk(page, LIBRARY);
  const failure = page.getByRole("alert").filter({ hasText: "Strategy library unavailable" });
  await expect(failure).toBeVisible();
  await expectCleanScreen(page);
  await page.unroute("**/api/desk/library**");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(presetRows(page)).toHaveCount(37);
  await expect(page.getByRole("article").getByRole("heading", { name: "In plain English" })).toBeVisible();
  await expectCleanScreen(page);
});
