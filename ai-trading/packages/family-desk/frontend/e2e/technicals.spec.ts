import { expect, test } from "@playwright/test";
import { openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

test("Technicals renders gauges, three tables, chart null gaps, and unavailable long windows", async ({ page }) => {
  await openDesk(page, "/technicals?symbol=NVDA&timeframe=1d");
  await expect(page.getByText("Desk Technical Bias", { exact: true }).first()).toBeVisible();
  for (const name of ["Oscillators", "Moving averages", "Pivots"]) {
    await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  }
  await expect(page.getByText("—").first()).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();

  await page.goto("/technicals?symbol=GAP&timeframe=1d");
  const gapChart = page.getByRole("region", { name: "GAP 1d market chart" });
  await expect(gapChart.getByText("Chart data table · 10 source bars")).toBeVisible();
  await expect(gapChart.getByLabel("Latest chart values")).toContainText("unavailable");
});

test("Futures ignores stale contract responses and shows root-specific roll rows", async ({ page }) => {
  await page.route("**/api/desk/bars/%2FMNQ**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await openDesk(page, "/futures");
  await page.getByRole("button", { name: /NQ \/ MNQ/ }).click();
  await page.getByRole("button", { name: /CL \/ MCL/ }).click();
  const mclChart = page.getByRole("region", { name: "/MCL 1d market chart" });
  await expect(mclChart.getByLabel("Latest chart values")).toContainText("Last close 191");
  await page.goto("/futures/specs");
  const es = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "ES", exact: true }) });
  const cl = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "CL", exact: true }) });
  await expect(es.getByRole("cell").nth(3)).toHaveText("2026-12-14 · 2027-03-15 · 2027-06-14 · 2027-09-13");
  await expect(cl.getByRole("cell").nth(3)).toHaveText("2026-11-13 · 2026-12-14 · 2027-01-13 · 2027-02-15");
  await expect(page.getByRole("heading", { name: /Upcoming roll dates/ })).toBeVisible();
});
