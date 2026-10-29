import type { Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";
import { fixture, mockFundamental, startInFundamental, watchGated } from "./fundamental-helpers";
import { test, expect, prepareDesk, openDesk, expectCleanScreen } from "./helpers";

// FD4 Covered calls · Scan and FD5 Open calls & income (02n §b3), at 1440 and 1180. The seeded database has no Flex import
// and no option chain, so the populated screens answer from the frozen fixtures; the unavailable chain is its own test.

test.beforeEach(async ({ context, page }) => {
  await prepareDesk(context, "technical");
  await startInFundamental(page);
});

const main = (page: Page) => page.locator("#main-content");
const candidatesTable = (page: Page) => page.getByRole("table", { name: "Covered-call candidates" });
const MASK = "•••••";

test("the scan lists coverage with counts hidden, then shows them; the top calls carry the engine's yield", async ({ page }) => {
  await mockFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/covered-calls");
  await expect(page.getByRole("heading", { name: "Covered calls", level: 1 })).toBeVisible();
  await expect(page.getByTestId("fund-cc-tab-scan")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("import-line")).toContainText("Holdings as of Fri 2026-10-23 close · IBKR Flex");

  const coverage = page.getByRole("table", { name: "Coverage" });
  await expect(coverage.locator("tbody tr")).toHaveCount(fixture<{ rows: unknown[] }>("covered_calls_coverage").rows.length);
  await expect(page.getByText("Cap 50% of shares")).toBeVisible();
  // Hidden by default: no share count, and the reason is a phrase without one.
  await expect(coverage.getByRole("row", { name: /^MSFT/ })).toContainText("Under one contract at the cap");
  await expect(coverage.getByRole("row", { name: /^MSFT/ })).toContainText(MASK);
  await expect(coverage.getByRole("row", { name: /^MSFT/ })).not.toContainText("150");

  // The first holding with something to sell is open: its three calls, the annualized yield from the engine, no opportunity yet.
  const calls = candidatesTable(page).locator("tbody tr");
  await expect(calls).toHaveCount(3);
  await expect(calls.first()).toContainText("16.1%");
  await expect(page.getByTestId("fund-cc-ivrank")).toHaveText("IV rank 62");
  await expect(page.getByTestId("fund-cc-opportunity")).toHaveCount(0);
  await expect(page.getByText("Cover the IRA first").first()).toBeVisible();
  await expect(page.getByTestId("fund-cc-payoff")).toBeVisible();

  // Showing values reveals the counts and the API's own sentence.
  await page.getByTestId("mask-toggle").click();
  await expect(coverage.getByRole("row", { name: /^MSFT/ })).toContainText("150 shares: under one contract at a 50% cap");
  expect(gated()).toEqual([]);
  await expectCleanScreen(page);
});

test("selecting another holding loads its scan: an opportunity banner, or no call passing the filters", async ({ page }) => {
  await mockFundamental(page);
  await openDesk(page, "/covered-calls");
  const coverage = page.getByRole("table", { name: "Coverage" });

  await coverage.getByRole("row", { name: /^AAPL IRA/ }).click();
  await expect(page.getByTestId("fund-cc-opportunity")).toContainText("Opportunity: a 2026-11-20 $245 call on AAPL yields");

  await coverage.getByRole("row", { name: /^KO/ }).click();
  await expect(page.getByTestId("fund-cc-nomatch")).toHaveText("No call passes your filters right now");
  await expect(candidatesTable(page)).toHaveCount(0);
  await expect(page.getByTestId("fund-cc-ivrank")).toContainText("IV rank needs more history · opportunity alerts start later (6 of 60 sessions)");
  await expectCleanScreen(page);
});

test("without a readable option chain the scan says so and shows no calls and no payoff", async ({ page }) => {
  await mockFundamental(page);
  const real = fixture<Record<string, unknown>>("covered_calls_candidates_aapl_1");
  await page.route(
    (url) => url.pathname === "/api/desk/covered-calls/candidates",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...real, candidates: [], opportunity: false, iv_rank: null, chain_stamp: { as_of: null, source: null, quality: "unavailable", freshness: "unavailable" } }),
      }),
  );
  await openDesk(page, "/covered-calls");
  await expect(page.getByTestId("fund-cc-notconnected")).toHaveText(COPY.optionQuotesNotConnected);
  await expect(candidatesTable(page)).toHaveCount(0);
  await expect(page.getByTestId("fund-cc-payoff")).toHaveCount(0);
  await expect(page.getByTestId("fund-cc-opportunity")).toHaveCount(0);
  await expectCleanScreen(page);
});

test("no alert control is live, no gated route is asked for, and orders stay off", async ({ page }) => {
  await mockFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/covered-calls");
  await expect(candidatesTable(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Alert me" })).toBeDisabled();
  await expect(main(page).getByText(COPY.alertTemplatesNotStarted)).toBeVisible();
  await expect(main(page).getByText(COPY.ordersOff)).toBeVisible();
  await page.getByTestId("fund-cc-tab-income").click();
  await expect(page.getByRole("table", { name: "Open short calls" })).toBeVisible();
  expect(gated()).toEqual([]);
  await expectCleanScreen(page);
});

test("open calls and income: risks in words, the selected call's roll pane, premium by month", async ({ page }) => {
  await mockFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/covered-calls#income");
  await expect(page.getByTestId("fund-cc-tab-income")).toHaveAttribute("aria-current", "page");
  const calls = page.getByRole("table", { name: "Open short calls" });
  await expect(calls.locator("tbody tr")).toHaveCount(3);
  await expect(calls.getByRole("row", { name: /^KO/ })).toContainText("Delta is above 0.50");
  await expect(calls.getByRole("row", { name: /^AAPL/ })).toContainText("No risks flagged");
  // A missing delta is a dash, never the word null.
  await expect(calls.getByRole("row", { name: /^JNJ/ })).toContainText("—");

  // The first call is open by default; the roll pane carries the assignment note and "Not tax advice".
  const pane = page.getByTestId("fund-cc-roll");
  await expect(pane).toContainText("AAPL $245 call · 2026-11-20");
  await calls.getByRole("row", { name: /^KO/ }).click();
  await expect(pane).toContainText("KO $72.5 call · 2026-10-30");
  await expect(page.getByTestId("fund-cc-risks").getByRole("listitem")).toHaveCount(3);
  await expect(pane).toContainText("Not tax advice");
  await expect(pane).toContainText("Cost to close $0.95 a share");
  await expect(page.getByRole("table", { name: "Roll choices" }).locator("tbody tr")).toHaveCount(2);
  // JNJ's chain is unavailable: one honest line instead of a price.
  await calls.getByRole("row", { name: /^JNJ/ }).click();
  await expect(page.getByTestId("fund-cc-roll-notconnected")).toHaveText(COPY.optionQuotesNotConnected);
  await expect(pane).toContainText("Not tax advice");

  // Premium by month: the chart, with the axis and the year to date hidden until values show.
  const income = page.getByTestId("fund-cc-income");
  await expect(income.getByRole("img", { name: "Premium by month" })).toBeVisible();
  await expect(income).toContainText(`Year to date ${MASK}`);
  await expect(income).not.toContainText("$4,910");
  await page.getByTestId("mask-toggle").click();
  await expect(income).toContainText("Year to date $4,910");
  await expect(income.getByRole("img", { name: "Premium by month" })).toContainText("$600");
  expect(gated()).toEqual([]);
  await expectCleanScreen(page);
});

test("premium income that needs the Trades section says so instead of drawing zeros", async ({ page }) => {
  await mockFundamental(page, { income: { by_month: [], assignments: [], ytd_premium: null, state: "needs_trades", source_stamp: { as_of: null, source: null, quality: "unavailable", freshness: "unavailable" } } });
  await openDesk(page, "/covered-calls#income");
  await expect(page.getByTestId("fund-cc-needs-trades")).toHaveText("Premium history needs the Flex Trades section");
  await expect(page.getByTestId("fund-cc-income").getByRole("img")).toHaveCount(0);
  await expectCleanScreen(page);
});

test("no table scrolls sideways on either tab", async ({ page }) => {
  await mockFundamental(page);
  for (const hash of ["scan", "income"]) {
    await openDesk(page, `/covered-calls#${hash}`);
    await expect(main(page).getByRole("table").first()).toBeVisible();
    await expect(page.getByTestId("fund-cc-tab-" + hash)).toHaveAttribute("aria-current", "page");
    // Wait for the screen's own tables: the candidates (scan) or the roll pane (income).
    await expect(hash === "scan" ? candidatesTable(page) : page.getByTestId("fund-cc-roll")).toBeVisible();
    const overflow = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll<HTMLElement>("#main-content table")].map((table) => table.parentElement!);
      return [document.querySelector<HTMLElement>("#main-content")!, ...wraps].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => `${node.className} ${node.scrollWidth}>${node.clientWidth}`);
    });
    expect(overflow, `sideways overflow on #${hash}`).toEqual([]);
  }
});
