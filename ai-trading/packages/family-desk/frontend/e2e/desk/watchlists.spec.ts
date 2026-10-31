import type { Locator, Page } from "@playwright/test";
import { expect, expectCleanScreen, openDesk, origin, prepareDesk, test, watchApi } from "./helpers";

// D7 Watchlists (02m §c2, §a3.5) against the real backend. Seed list ids: Day movers 1, Swing 2.

const DAY_MOVERS = 1;
const SWING = 2;
const DAY_MOVERS_SYMBOLS = ["NVDA", "AMD", "TSLA", "PLTR", "META", "AAPL", "AVGO", "COIN"];
const SWING_SYMBOLS = ["MSFT", "AMZN", "GOOGL", "CRWD", "SHOP", "UBER"];

/** Where a DenseTable's cells sit against its clipping wrapper (`overflow-x: hidden`): nothing may hang past the right edge. */
const tableFit = (table: Locator) =>
  table.evaluate((node) => {
    const wrap = node.parentElement!;
    const edge = wrap.getBoundingClientRect().right;
    const past = (el: Element) => Math.round(el.getBoundingClientRect().right - edge);
    return {
      overflow: wrap.scrollWidth - wrap.clientWidth,
      cellsPast: [...node.querySelectorAll("th, td")].map(past).filter((px) => px > 0),
      // A cell whose own content is wider than the cell (a header or figure cut by a squeezed column).
      cellsCut: [...node.querySelectorAll<HTMLElement>("th, td")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
    };
  });

const listSwitch = (page: Page) => page.getByRole("combobox", { name: "Watchlist", exact: true });
const symbolTable = (page: Page) => page.getByRole("table", { name: "Watchlist", exact: true });
const manageButton = (page: Page) => page.getByRole("button", { name: "Manage", exact: true });
const savedStatus = (page: Page) => page.getByRole("status").filter({ hasText: /^Saved$/ });
async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${origin}${path}`);
  expect(response.ok(), path).toBeTruthy();
  return (await response.json()) as T;
}

/** The list's symbols in stored position order. The items and the table read must agree on it. */
async function storedOrder(page: Page, listId: number): Promise<string[]> {
  const items = await apiGet<Array<{ symbol: string }>>(page, `/api/desk/watchlists/${listId}/items`);
  const table = await apiGet<{ rows: Array<{ symbol: string }> }>(page, `/api/desk/watchlists/${listId}/table`);
  const order = items.map((item) => item.symbol);
  expect(table.rows.map((row) => row.symbol)).toEqual(order);
  return order;
}

/** Each table row's first cell starts with that row's symbol (the symbol precedes the company name). */
const expectRowSymbols = (page: Page, symbols: string[]) =>
  expect(symbolTable(page).locator("tbody tr td:first-child")).toHaveText(symbols.map((symbol) => new RegExp(`^${symbol}`)));

test.describe("technical seed", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

  test("the switcher offers Day movers and Swing, and Day movers lists its eight symbols in stored order", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await expect(page.getByRole("heading", { level: 1, name: "Day movers" })).toBeVisible();
    await expect(listSwitch(page).locator("option")).toHaveText(["Day movers", "Swing"]);
    expect(await storedOrder(page, DAY_MOVERS)).toEqual(DAY_MOVERS_SYMBOLS); // NVDA first, as seeded
    await expectRowSymbols(page, DAY_MOVERS_SYMBOLS);
    await expectCleanScreen(page);
  });

  // V-Today-02 / V-Watchlists-02: the left rail table was 316 px wide inside a 255 px scroller, so Chg % read "-0.5" for -0.59%.
  for (const path of ["/", "/watchlists"]) {
    test(`the left rail's table fits its rail at ${path}: Chg % is whole and nothing hangs past the edge`, async ({ page }) => {
      await openDesk(page, path);
      const rail = page.getByRole("table", { name: "Watchlist symbols", exact: true });
      await expect(rail.getByRole("columnheader", { name: "Chg %", exact: true })).toBeVisible();
      await expect(rail.locator("tbody tr")).not.toHaveCount(0);
      expect(await tableFit(rail)).toEqual({ overflow: 0, cellsPast: [], cellsCut: [] });
      await expectCleanScreen(page);
    });
  }

  test("switching the list to Swing shows its six symbols", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await listSwitch(page).selectOption("Swing");
    await expect(page.getByRole("heading", { level: 1, name: "Swing" })).toBeVisible();
    await expectRowSymbols(page, SWING_SYMBOLS);
    expect(await storedOrder(page, SWING)).toEqual(SWING_SYMBOLS);
    await expectCleanScreen(page);
  });

  test("RVOL and Bias show at 1440 and are dropped at 1180; the quote meter reads the slot count", async ({ page }) => {
    await openDesk(page, "/watchlists");
    const wide = test.info().project.name === "desktop-1440";
    for (const label of ["RVOL", "Bias"]) {
      const header = symbolTable(page).getByRole("columnheader", { name: label, exact: true });
      if (wide) await expect(header).toBeVisible();
      else await expect(header).toHaveCount(0);
    }
    await expect(symbolTable(page).getByRole("columnheader", { name: "Strategy", exact: true })).toBeVisible();
    const status = await apiGet<{ streaming_slots: { used: number; max: number } }>(page, "/api/desk/status");
    const { used, max } = status.streaming_slots;
    await expect(page.getByText(`Quote slots: ${used} of ${max}`, { exact: true })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("the right rail names Day movers' strategies, with an Add preset link to the library", async ({ page }) => {
    await openDesk(page, "/watchlists");
    const presetHref = `/strategies/library?watchlist=${DAY_MOVERS}`;
    if (test.info().project.name === "desktop-1440") {
      const rail = page.getByRole("complementary", { name: "Strategies on this list" });
      await expect(rail.getByRole("heading", { level: 3, name: "Strategies on Day movers" })).toBeVisible();
      await expect(rail.getByRole("listitem")).toHaveCount(5);
      await expect(rail.getByRole("link", { name: "Add preset" })).toHaveAttribute("href", presetHref);
    } else {
      // At 1180 the rail is a 40 px tab strip; its tab opens the same section in a drawer.
      await page.getByRole("tablist", { name: "Strategies on this list" }).getByRole("tab", { name: "Strategies" }).click();
      const drawer = page.getByRole("dialog", { name: "Strategies" });
      await expect(drawer.getByRole("heading", { level: 3, name: "Strategies on Day movers" })).toBeVisible();
      await expect(drawer.getByRole("link", { name: "Add preset" })).toHaveAttribute("href", presetHref);
    }
    await expectCleanScreen(page);
  });

  test("pressing Enter on the NVDA row opens its chart", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await symbolTable(page).getByRole("row", { name: /^NVDA/ }).press("Enter");
    await expect(page).toHaveURL(/\/technicals\?symbol=NVDA#chart$/);
    await expect(page.locator("#main-content")).toBeVisible();
    await expectCleanScreen(page);
  });

  test("adding SPY from Manage and removing it after confirmation both persist across a reload", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await manageButton(page).click();
    await page.getByRole("textbox", { name: "Add a symbol" }).fill("SPY");
    await page.getByRole("button", { name: "Add symbol" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added SPY" })).toBeVisible();
    expect(await storedOrder(page, DAY_MOVERS)).toEqual([...DAY_MOVERS_SYMBOLS, "SPY"]); // new symbols go last
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Day movers" })).toBeVisible();
    await manageButton(page).click();
    await page.getByRole("button", { name: "Remove SPY" }).click();
    await page.getByRole("button", { name: "Yes, remove" }).click();
    await expect(savedStatus(page)).toBeVisible();
    expect(await storedOrder(page, DAY_MOVERS)).toEqual(DAY_MOVERS_SYMBOLS);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Day movers" })).toBeVisible();
    await expect(symbolTable(page).locator("tbody tr")).toHaveCount(DAY_MOVERS_SYMBOLS.length);
    await expectCleanScreen(page);
  });

  test("moving NVDA down and saving the order keeps it after a reload", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await manageButton(page).click();
    const save = page.getByRole("button", { name: "Save order" });
    await expect(save).toBeDisabled(); // nothing moved yet
    await page.getByRole("button", { name: "Move NVDA down" }).press("Enter"); // keyboard-operable native button
    await expect(save).toBeEnabled();
    await save.click();
    await expect(savedStatus(page)).toBeVisible();
    const reordered = ["AMD", "NVDA", ...DAY_MOVERS_SYMBOLS.slice(2)];
    expect(await storedOrder(page, DAY_MOVERS)).toEqual(reordered);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Day movers" })).toBeVisible();
    await expectRowSymbols(page, reordered);
    await expectCleanScreen(page);
  });

  test("renaming Swing persists; a name Day movers already uses is refused before anything is sent", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await listSwitch(page).selectOption("Swing");
    await manageButton(page).click();
    const api = watchApi(page);
    const name = page.getByRole("textbox", { name: "List name" });
    await name.fill("Day movers");
    await expect(page.getByText(/You already have a list called/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(api.paths().filter((path) => path.startsWith("PATCH"))).toEqual([]);
    await name.fill("Swing ideas");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(savedStatus(page)).toBeVisible();
    const lists = await apiGet<Array<{ id: number; name: string }>>(page, "/api/desk/watchlists");
    expect(lists.map((list) => list.name)).toEqual(["Day movers", "Swing ideas"]);
    await page.reload();
    await expect(listSwitch(page).locator("option")).toHaveText(["Day movers", "Swing ideas"]);
    await expectCleanScreen(page);
  });

  test("a name taken after the page loaded gets the server's 409 message and the list keeps its name", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await manageButton(page).click();
    // Another session creates "Scratch" after this page loaded its lists, so the local duplicate check cannot see it.
    const created = await page.request.post(`${origin}/api/desk/watchlists`, { data: { name: "Scratch", horizon: "intraday" } });
    expect(created.status()).toBe(201);
    await page.getByRole("textbox", { name: "List name" }).fill("Scratch");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /name already exists/ })).toBeVisible();
    const lists = await apiGet<Array<{ id: number; name: string }>>(page, "/api/desk/watchlists");
    expect(lists.find((list) => list.id === DAY_MOVERS)?.name).toBe("Day movers");
    await expectCleanScreen(page);
  });

  test("a new list with no symbols shows the empty state with an add-symbol form", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await manageButton(page).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Scratch");
    await page.getByRole("button", { name: "Create list" }).click();
    await expect(savedStatus(page)).toBeVisible();
    await listSwitch(page).selectOption("Scratch");
    await manageButton(page).click(); // leave manage mode to see the list itself
    await expect(page.getByRole("heading", { level: 1, name: "Scratch" })).toBeVisible();
    // The left rail shows the same empty title for an empty list, so the check is scoped to the centre.
    const center = page.locator("#main-content");
    await expect(center.getByText("Add symbols to start watching", { exact: true })).toBeVisible();
    await expect(center.getByRole("textbox", { name: "Add a symbol" })).toBeVisible();
    await expectCleanScreen(page);
  });
});

test.describe("technical-alerts seed", () => {
  test.beforeEach(async ({ context }) => prepareDesk(context, "technical-alerts"));

  test("NVDA's row shows its Hammer fire with the time, and AMD's row shows the strategies still armed", async ({ page }) => {
    await openDesk(page, "/watchlists");
    await expect(symbolTable(page).getByRole("row", { name: /^NVDA/ }).getByText("Hammer 15m near S1 · 3:15 PM", { exact: true })).toBeVisible();
    await expect(symbolTable(page).getByRole("row", { name: /^AMD/ }).getByText("ORB 15m armed", { exact: true })).toBeVisible();
    await expectCleanScreen(page);
  });

  // V-Watchlists-01: three armed chips pushed the table to 982 px inside 808, so "+ Alert" never appeared.
  test("a row with several strategies keeps every column, and its + Alert action, inside the table", async ({ page }) => {
    await openDesk(page, "/watchlists");
    const table = symbolTable(page);
    expect(await tableFit(table)).toEqual({ overflow: 0, cellsPast: [], cellsCut: [] });
    const amd = table.getByRole("row", { name: /^AMD/ });
    await amd.hover();
    await expect(amd.getByRole("link", { name: "+ Alert" })).toBeInViewport({ ratio: 1 });
    await expectCleanScreen(page);
  });
});
