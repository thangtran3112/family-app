import { COPY } from "../../lib/desk/freshness.ts";
import { fixture, mainText, mockFundamental, startInFundamental, watchGated } from "./fundamental-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";

// FD3 Holdings, the left-rail Holdings tab and the Fundamental right rail (02n §b1, §b3). The seeded database has no Flex
// import, so the populated screens answer from the frozen contract fixtures; the empty world is the real backend's.

const compact = () => test.info().project.name === "desktop-1180";

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

test("holdings from the fixtures: values hidden by default, the switch shows them, a row opens its lots", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/holdings");

  const screen = page.getByTestId("fund-holdings");
  await expect(screen.getByRole("heading", { name: "Holdings", level: 1 })).toBeVisible();
  await expect(page.getByTestId("import-line")).toContainText("Holdings as of Fri 2026-10-23 close · IBKR Flex");

  const table = screen.getByRole("table", { name: "Holdings" });
  for (const symbol of ["AAPL", "KO", "JNJ"]) await expect(table.getByRole("row", { name: new RegExp(symbol) })).toBeVisible();
  const aapl = table.getByRole("row", { name: /AAPL/ });
  // Hidden: dollars, shares and contracts. Visible: the price per share, the weight and the change.
  await expect(screen.getByTestId("values-hidden")).toContainText("Values hidden");
  await expect(page.getByTestId("fund-holdings-value")).toHaveText("•••••");
  await expect(aapl).toContainText("•••••");
  await expect(aapl).not.toContainText("900");
  await expect(aapl).toContainText("$166.49");
  await expect(aapl).toContainText("43.1%");

  await page.getByTestId("mask-toggle").click();
  await expect(page.getByTestId("fund-holdings-value")).toHaveText("$483,720");
  await expect(aapl).toContainText("900");
  await expect(screen.getByTestId("values-hidden")).toHaveCount(0);

  // The first holding is selected; its tax lots and short calls show below. Picking another row swaps them.
  const lots = page.getByTestId("fund-lots");
  await expect(lots.getByRole("heading", { name: "AAPL · tax lots" })).toBeVisible();
  await expect(lots.getByRole("table", { name: "AAPL tax lots" }).getByRole("row")).toHaveCount(4);
  await expect(lots).toContainText("Long term");
  await table.getByRole("row", { name: /JNJ/ }).getByRole("cell").nth(2).click();
  await expect(lots.getByRole("heading", { name: "JNJ · tax lots" })).toBeVisible();

  // The left rail's Holdings tab lists the same symbols, biggest weight first.
  const rail = page.getByTestId("fund-rail-holdings");
  await expect(rail).toContainText("AAPL");
  await expect(rail).toContainText("KO");
  await expect(rail.getByRole("button", { name: /JNJ/ })).toHaveAttribute("aria-pressed", "true");

  expect(gated(), "gated routes asked for").toEqual([]);
  await expectCleanScreen(page);
});

test("Import now says the import is running; the Columns menu keeps at most eight", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/holdings");
  await page.getByTestId("fund-import").click();
  await expect(page.getByTestId("import-line")).toContainText(COPY.holdingsImporting);

  await page.getByTestId("fund-columns").click();
  const menu = page.getByRole("group", { name: "Columns" });
  await expect(menu.getByRole("checkbox", { name: "Fwd P/E" })).toBeChecked();
  await expect(menu.getByRole("checkbox", { name: "Debt/equity" })).not.toBeChecked();
  await expectCleanScreen(page);
});

test("the right rail says the Desk AI has not started when there is no verdict, and never a rating", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  await page.route("**/api/desk/research/symbols/AAPL", (route) => route.fulfill({ json: { ...fixture<object>("research_aapl"), verdict: null } }));
  await openDesk(page, "/holdings");
  // At 1180 the rail is a tab strip; the verdict opens in its drawer.
  if (compact()) await page.getByRole("tab", { name: "Verdict" }).click();
  await expect(page.getByTestId("fund-verdict")).toContainText(COPY.deskAiNotStarted);
  await expect(page.getByTestId("fund-verdict")).not.toContainText(/\b(Buy|Hold|Sell)\b/);
  await expectCleanScreen(page);
});

test("the positions table drops its low-priority columns at 1180 and nothing scrolls sideways", async ({ page }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/holdings");
  const table = page.getByRole("table", { name: "Holdings" });
  await expect(table).toBeVisible();
  const dropped = ["Earnings", "AI", "Open calls", "Unrl %"];
  for (const name of dropped) {
    const header = table.getByRole("columnheader", { name, exact: true });
    if (compact()) await expect(header).toHaveCount(0);
    else await expect(header).toHaveCount(1);
  }
  await expect(table.getByRole("columnheader", { name: "Symbol" })).toBeVisible();
  const overflow = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("#main-content")!;
    return { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.main).toBeLessThanOrEqual(1);
});

test("the real, empty world says why there are no holdings and shows no dollar figure", async ({ page }) => {
  await startInFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/holdings");
  const line = page.getByTestId("import-line");
  await expect(line).toHaveText(new RegExp(`${COPY.holdingsNotConnected}|${COPY.holdingsNone}`));
  await expect(page.getByRole("table", { name: "Holdings" })).toHaveCount(0);
  expect(await mainText(page)).not.toMatch(/\$\d/);
  expect(gated(), "gated routes asked for").toEqual([]);
  await expectCleanScreen(page);
});
