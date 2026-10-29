import { test, expect, prepareDesk, openDesk, expectCleanScreen, origin } from "./helpers";
import { mockFundamental, startInFundamental, watchGated } from "./fundamental-helpers";

// 02n §b3: no Fundamental table scrolls sideways, at 1440 or 1180. DenseTable hides overflow instead of scrolling, so a table
// wider than its column loses columns without a scrollbar: this spec compares each table with the column that holds it.
test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

const ROUTES = [
  "/",
  "/holdings",
  "/covered-calls#scan",
  "/covered-calls#income",
  "/stocks",
  "/stocks?symbol=AAPL#overview",
  "/stocks?symbol=AAPL#valuation",
  "/stocks?symbol=KO#timeline",
  "/futures/read",
  "/settings",
];

async function clipped(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const table of document.querySelectorAll<HTMLElement>("#main-content table")) {
      const wrap = table.parentElement!;
      if (table.scrollWidth > wrap.clientWidth + 1 || wrap.scrollWidth > wrap.clientWidth + 1) {
        out.push(`${table.getAttribute("aria-label") ?? "table"} ${Math.max(table.scrollWidth, wrap.scrollWidth)}>${wrap.clientWidth}`);
      }
    }
    if (document.scrollingElement!.scrollWidth > window.innerWidth) out.push("the page scrolls sideways");
    return out;
  });
}

test("every Fundamental screen fits its column: no clipped table, no sideways scroll", async ({ page }) => {
  const gated = watchGated(page);
  await startInFundamental(page);
  await mockFundamental(page);
  for (const route of ROUTES) {
    await openDesk(page, route);
    // Let the screen's own reads land, and open the lots pane on Holdings (it is part of the screen).
    await page.waitForTimeout(800);
    await expect(page.locator("#main-content").getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0);
    expect(await clipped(page), route).toEqual([]);
  }
  expect(gated()).toEqual([]);
});

test("eight chosen metric columns still fit the Fundamentals table", async ({ page }) => {
  const saved = await page.request.put(`${origin}/api/desk/settings`, {
    data: { settings: { fundamental_columns: ["fwd_pe", "pe_vs_5y_median_pct", "fcf_yield_pct", "revenue_growth_yoy_pct", "debt_to_equity", "eps_rev_30d_pct", "next_earnings", "ai_target_base"] } },
  });
  expect(saved.ok()).toBeTruthy();
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/holdings");
  await expect(page.getByRole("table", { name: "Fundamentals" })).toBeVisible();
  expect(await clipped(page)).toEqual([]);
  await expectCleanScreen(page);
});
