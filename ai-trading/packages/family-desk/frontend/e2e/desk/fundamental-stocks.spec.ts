import type { Page } from "@playwright/test";
import { COPY } from "../../lib/desk/freshness.ts";
import { fixture, mockFundamental, startInFundamental, watchGated } from "./fundamental-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";

// Research (02n FD7 to FD10): the brief at /stocks and one stock at /stocks?symbol=…#overview|valuation|timeline. The seeded
// database has no Desk AI run, so the brief and the verdict are empty in the real world and the screens say "not started";
// the populated views answer from the frozen contract fixtures. No spec here may reach a gated route.

const narrow = () => test.info().project.name === "desktop-1180";
const main = (page: Page) => page.locator("#main-content");
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth), "scrolls sideways").toBeLessThanOrEqual(0);

test.beforeEach(async ({ context, page }) => {
  await prepareDesk(context, "technical");
  await startInFundamental(page);
});

test("the real backend before the first Desk AI run: the brief says not started and the track record shows zeros", async ({ page }) => {
  const gated = watchGated(page);
  await openDesk(page, "/stocks");
  await expect(main(page).getByRole("heading", { name: "Stocks", level: 1 })).toBeVisible();
  await expect(page.getByTestId("fund-brief-notstarted")).toContainText(COPY.deskAiNotStarted);
  await expect(page.getByRole("table", { name: "AI daily brief" })).toHaveCount(0);
  const tiles = page.getByRole("list", { name: "Desk AI track record" }).getByRole("listitem");
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toContainText("Calls");
  await noSidewaysScroll(page);
  await expectCleanScreen(page);
  expect(gated()).toEqual([]);
});

test("the brief lists every analyzed stock with its run line, columns that drop at 1180 and the stale footnote", async ({ page }) => {
  await mockFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/stocks");
  const table = page.getByRole("table", { name: "AI daily brief" });
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("link", { name: "AAPL" })).toHaveAttribute("href", "/stocks?symbol=AAPL#overview");
  await expect(page.getByTestId("fund-brief-run")).toHaveText("Ran Fri 2026-10-23 · 5:05 PM ET · 4 analyzed · 1 skipped · cost $0.42");
  await expect(table.getByRole("row", { name: /MSFT/ })).toContainText("Buy → Hold");
  await expect(table.getByRole("row", { name: /NVDA/ })).toContainText("New");
  await expect(main(page).getByRole("list", { name: "Stale views" })).toContainText("NVDA: Desk AI view from Thu · today's update didn't finish");
  if (narrow()) {
    await expect(table.getByRole("columnheader", { name: "EPS rev. 30d" })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: "Confidence" })).toHaveCount(0);
  } else {
    await expect(table.getByRole("columnheader", { name: "EPS rev. 30d" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Confidence" })).toBeVisible();
  }
  await noSidewaysScroll(page);
  await expectCleanScreen(page);
  expect(gated()).toEqual([]);
});

test("a stock's overview shows the not-started verdict, consensus EPS with revisions, targets as context and a disabled Alert me", async ({ page }) => {
  await mockFundamental(page);
  // The fixture carries a verdict; before step 5 the real service answers null.
  await page.route("**/api/desk/research/symbols/AAPL", (route) => route.fulfill({ json: { ...fixture<object>("research_aapl"), verdict: null } }));
  const gated = watchGated(page);
  await openDesk(page, "/stocks?symbol=AAPL");
  await expect(main(page).getByRole("heading", { name: "AAPL", level: 1 })).toBeVisible();
  await expect(page.getByTestId("fund-stock-tab-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("fund-verdict-card")).toContainText(COPY.deskAiNotStarted);
  const consensus = page.getByTestId("fund-consensus");
  await expect(consensus).toContainText("Q4 2026");
  await expect(consensus).toContainText("$2.04");
  await expect(consensus).toContainText("Revised 30 days");
  await expect(consensus).toContainText("+1.4%");
  await expect(consensus.getByRole("table", { name: "Earnings surprises" })).toContainText("Beat");
  await expect(consensus.getByRole("table", { name: "Earnings surprises" })).toContainText("Miss");
  await expect(page.getByTestId("fund-targets")).toContainText("24 Buy · 9 Hold · 2 Sell");
  await expect(main(page).getByRole("button", { name: "Alert me" })).toBeDisabled();
  await expect(main(page)).toContainText(COPY.alertTemplatesNotStarted);
  const chart = page.getByTestId("fund-chart");
  await expect(chart.getByRole("radio", { name: "1D" })).toBeChecked();
  await chart.getByRole("radio", { name: "1W" }).click();
  await expect(chart.getByRole("radio", { name: "1W" })).toBeChecked();
  await noSidewaysScroll(page);
  await expectCleanScreen(page);
  expect(gated()).toEqual([]);
});

test("a verdict, when there is one, shows its rating, target range and how it was decided", async ({ page }) => {
  await mockFundamental(page);
  await openDesk(page, "/stocks?symbol=AAPL");
  const card = page.getByTestId("fund-verdict-card");
  await expect(card).toContainText("Buy");
  await expect(card).toContainText("Base target $265.00");
  await expect(card).toContainText("72% confidence");
  await expect(card).toContainText("Unchanged: still a Buy");
  await card.getByText("How Desk AI decided").click();
  await expect(card).toContainText("Bull case.");
  await expect(card).toContainText("Bear case.");
  await expect(card).toContainText("SEC filings · as of");
  await expectCleanScreen(page);
});

test("a revision with no history yet says so in words, never a zero", async ({ page }) => {
  await mockFundamental(page);
  await openDesk(page, "/stocks?symbol=JNJ");
  await expect(page.getByTestId("fund-verdict-card")).toContainText(COPY.deskAiNotStarted);
  await expect(page.getByTestId("fund-consensus").getByText("Needs more history")).toHaveCount(3);
  await expectCleanScreen(page);
});

test("the Valuation tab shows the four methods, the engine's fallback sentences, the blend and the earnings reaction", async ({ page }) => {
  await mockFundamental(page);
  const gated = watchGated(page);
  await openDesk(page, "/stocks?symbol=AAPL#overview");
  await page.getByTestId("fund-stock-tab-valuation").click();
  await expect(page).toHaveURL(/\?symbol=AAPL#valuation$/);
  await expect(page.getByTestId("fund-stock-tab-valuation")).toHaveAttribute("aria-current", "page");
  const valuation = page.getByTestId("fund-valuation");
  await expect(valuation.getByTestId("fund-method-dcf")).toContainText("$259.17");
  await expect(valuation.getByTestId("fund-method-owner_earnings")).toContainText("$242.97");
  await expect(valuation.getByTestId("fund-method-ev_ebitda")).toContainText("$222.14");
  await expect(valuation.getByTestId("fund-method-ev_ebitda")).toContainText("How this was estimated · EBITDA multiple: the sector median, no five-year history");
  await expect(valuation.getByTestId("fund-method-residual_income")).toContainText("Book value growth: 4% default");
  await expect(valuation).toContainText("Blend is above the price");
  const reaction = page.getByTestId("fund-reaction");
  await expect(reaction).toContainText("Average vs SPY");
  await expect(reaction.getByRole("img", { name: /Price move on each of the last 8 earnings reports/ })).toBeVisible();
  await expect(page.getByTestId("fund-implied-move")).toHaveText("Options imply a move of ±4.6%");
  await noSidewaysScroll(page);
  await expectCleanScreen(page);
  expect(gated()).toEqual([]);
});

test("an earnings reaction without an implied move names the option-quote state", async ({ page }) => {
  await mockFundamental(page);
  await page.route("**/api/desk/research/symbols/AAPL/valuation", (route) => {
    const body = fixture<{ earnings_reaction: object }>("research_valuation_aapl");
    return route.fulfill({ json: { ...body, earnings_reaction: { ...body.earnings_reaction, implied_move_pct: null } } });
  });
  await openDesk(page, "/stocks?symbol=AAPL#valuation");
  await expect(page.getByTestId("fund-implied-move")).toHaveText(COPY.optionQuotesNotConnected);
  await expectCleanScreen(page);
});

test("the Timeline tab filters by kind, links out safely, and the Desk AI filter before the first run says not started", async ({ page }) => {
  await mockFundamental(page);
  await page.route("**/api/desk/research/symbols/KO/timeline**", (route) =>
    new URL(route.request().url()).searchParams.get("kind") === "desk_ai" ? route.fulfill({ json: { items: [], total: 0 } }) : route.fallback(),
  );
  const gated = watchGated(page);
  await openDesk(page, "/stocks?symbol=KO#timeline");
  const timeline = page.getByTestId("fund-timeline");
  await expect(timeline.getByRole("button", { name: /^(All|Earnings|Desk AI|News|Strategy|Filings)$/ })).toHaveText(["All", "Earnings", "Desk AI", "News", "Strategy", "Filings"]);
  await expect(timeline.getByRole("listitem")).toHaveCount(7);
  await expect(timeline.getByRole("listitem").first()).toContainText("GDP, advance estimate");
  const link = timeline.getByRole("link", { name: "10-Q filed" });
  await expect(link).toHaveAttribute("href", "https://example.com/filings/ko");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  const asked = page.waitForRequest((request) => request.url().includes("/timeline") && request.url().includes("kind=news"));
  await timeline.getByRole("button", { name: "News" }).click();
  await asked;
  await expect(timeline.getByRole("button", { name: "News" })).toHaveAttribute("aria-pressed", "true");
  await expect(timeline.getByText("Beverage volumes hold up as pricing eases")).toBeVisible();
  await timeline.getByRole("button", { name: "Desk AI" }).click();
  await expect(timeline).toContainText(COPY.deskAiNotStarted);
  await noSidewaysScroll(page);
  await expectCleanScreen(page);
  expect(gated()).toEqual([]);
});

test("something that is not a ticker gets a plain notice, not a broken page", async ({ page }) => {
  await openDesk(page, "/stocks?symbol=%3Cb%3E");
  await expect(main(page).getByRole("status").filter({ hasText: "doesn't look like a ticker" })).toBeVisible();
  await expectCleanScreen(page);
});
