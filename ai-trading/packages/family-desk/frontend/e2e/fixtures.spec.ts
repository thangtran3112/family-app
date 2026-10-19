import { expect, test } from "@playwright/test";
import { openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

for (const [path, phase] of [["/paper", "6"], ["/holdings", "5"], ["/ask", "7"], ["/covered-calls", "5"], ["/stocks", "5"], ["/backtests", "6b"]]) {
  test(`${path} is explicitly fixture-only with zero Desk API calls`, async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/desk")) calls.push(request.url()); });
    await openDesk(page, path);
    await expect(page.getByRole("status")).toContainText(`Fixture — wired in Phase ${phase}`);
    expect(calls).toEqual([]);
  });
}
