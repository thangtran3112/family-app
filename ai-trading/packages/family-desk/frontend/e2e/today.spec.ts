import { expect, test } from "@playwright/test";
import { api, openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

test("Today renders real labelled bars, canvas, semantic data table, and cleans up SSE", async ({ page }) => {
  await openDesk(page);
  const row = page.getByRole("row").filter({ hasText: "NVDA" });
  await expect(row).toContainText("delayed-15m");
  await expect(row).toContainText("as of");
  await page.getByRole("button", { name: "Show chart for NVDA" }).click();
  const chart = page.getByRole("region", { name: "NVDA 5m market chart" });
  await expect(chart.locator("canvas").first()).toBeVisible();
  await chart.getByText(/Chart data table/).click();
  await expect(chart.getByRole("columnheader", { name: "Close" })).toBeVisible();
  await expect.poll(async () => (await api(page, "/api/desk/__e2e/runtime")).json())
    .toMatchObject({ active_sessions: 0, active_streams: expect.any(Number) });
  expect((await (await api(page, "/api/desk/__e2e/runtime")).json()).active_streams).toBeGreaterThan(0);

  await page.goto("/paper");
  await expect.poll(async () => (await api(page, "/api/desk/__e2e/runtime")).json())
    .toMatchObject({ active_sessions: 0, active_streams: 0, streams_closed: expect.any(Number) });
  expect((await (await api(page, "/api/desk/__e2e/runtime")).json()).streams_closed).toBeGreaterThan(0);
});
