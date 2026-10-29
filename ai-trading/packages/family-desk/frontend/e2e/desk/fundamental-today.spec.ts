import { COPY } from "../../lib/desk/freshness.ts";
import { test, expect, prepareDesk, openDesk, expectCleanScreen } from "./helpers";
import { mockFundamental, startInFundamental, watchGated } from "./fundamental-helpers";

// FD2 Today, Fundamental variant (02n §b3). The e2e database has no Flex import, so the populated page answers from the
// frozen contract fixtures; the empty page is the real backend. Neither ever asks a gated route.

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

test("Today hides dollars until the toggle, lists the call risks, and never asks a gated route", async ({ page }) => {
  const gated = watchGated(page);
  await startInFundamental(page);
  await mockFundamental(page);
  await openDesk(page, "/");

  await expect(page.getByTestId("fund-today")).toBeVisible();
  await expect(page.getByTestId("import-line")).toHaveText("Holdings as of Fri 2026-10-23 close · IBKR Flex · 10 lots");
  const value = page.getByTestId("fund-portfolio-value");
  await expect(value).toContainText("•••••");
  await expect(value).not.toContainText(/\d/);
  await expect(page.getByTestId("fund-income")).toContainText("•••••");
  await expect(page.getByTestId("fund-values-hidden")).toContainText("Values hidden");

  // The KO call's three engine risks are in the feed with the call named; percentages and dates stay visible while masked.
  const feed = page.getByTestId("fund-feed");
  await expect(feed).toContainText("Delta is above 0.50: assignment is now more likely than not");
  await expect(feed).toContainText("KO · $72.50 call · expires Fri 2026-10-30");
  await expect(page.getByTestId("fund-portfolio-day")).toContainText("+0.52%");
  await expect(page.getByTestId("fund-open-calls")).toContainText("Next expiry Fri 2026-10-30");

  // Desk AI has not run yet and futures prices are not connected: both say so plainly, with no sample verdict.
  await expect(page.getByTestId("desk-ai-not-started")).toHaveText(COPY.deskAiNotStarted);
  await expect(page.getByTestId("fund-futures-deferred")).toContainText(COPY.futuresDeferred);

  await page.getByTestId("mask-toggle").click();
  await expect(value).toContainText("$483,720");
  await expect(page.getByTestId("fund-income")).toContainText("$345");
  await expect(page.getByTestId("fund-values-hidden")).toHaveCount(0);

  // No sideways scroll at either band.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(gated()).toEqual([]);
  await expectCleanScreen(page);
});

test("Today with no holdings import says so in words and shows no dollar figure", async ({ page }) => {
  const gated = watchGated(page);
  await startInFundamental(page);
  await openDesk(page, "/");

  await expect(page.getByTestId("fund-today")).toBeVisible();
  const line = page.getByTestId("import-line");
  await expect(line).toHaveText(new RegExp(`^(${[COPY.holdingsNotConnected, COPY.holdingsNone].map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`));
  await expect(page.getByTestId("fund-feed")).toContainText((await line.innerText()).trim());
  await expect(page.getByTestId("fund-portfolio-value")).toContainText("—");
  await expect(page.getByTestId("fund-today")).not.toContainText(/\$\d/);
  await expect(page.getByTestId("desk-ai-not-started")).toHaveText(COPY.deskAiNotStarted);
  expect(gated()).toEqual([]);
  await expectCleanScreen(page);
});
