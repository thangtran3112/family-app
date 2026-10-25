import { expect, test } from "@playwright/test";
import { openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

for (const path of ["/paper", "/holdings", "/ask", "/covered-calls", "/stocks", "/backtests"]) {
  test(`${path} is explicitly fixture-only with zero Desk API calls`, async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/desk")) calls.push(request.url()); });
    await openDesk(page, path);
    await expect(page.getByRole("status")).toContainText("Preview · not connected yet");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(calls).toEqual([]);
  });
}
