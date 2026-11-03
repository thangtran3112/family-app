import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { stepBar } from "./clock-helpers";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { get, placeOrder, replayRail } from "./hub-helpers";
import { startLane } from "./lane-helpers";

// D-215 (wave 15) and its family: the Trades tab's "Summary so far" tiles count in the singular for one. A day tile never reads "1 days" (the old
// copy read "of 1 days opened"), and the win rate tile reads "1 of 1 trade", never "1 of 1 trades". One closed trade on one ET date is the smallest
// journal that shows both.

test.describe("Practice summary tiles", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("one closed trade reads singular in the Summary so far tiles", async ({ page, context }) => {
    test.setTimeout(180_000);
    const { threadId } = await startLane(page, context, { thread: { maxLoss: 600, maxTrades: 3 } });
    await stepBar(page);
    const practice = await replayRail(page, "Practice");
    await practice.getByRole("textbox", { name: "Quantity" }).fill("100");
    await practice.getByRole("button", { name: "Buy" }).click();
    await page.getByRole("tab", { name: "Marks" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Practice buy");
    // The market moves while the position is open: a round trip at one print is flat, and a flat trade is neither a win nor a loss.
    await stepBar(page, 3);
    await placeOrder(page, "Close position");
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");

    const read = (await get(context, `/threads/${threadId}`)) as { thread: { stats: { wins: number; losses: number } } };
    expect(read.thread.stats.wins + read.thread.stats.losses, "one closed trade").toBe(1);

    await openDesk(page, `/practice/journal?thread=${threadId}`);
    const summary = page.getByRole("region", { name: PRACTICE_COPY.summaryTitle });
    await expect(summary).toBeVisible();
    const tile = (label: string) => summary.getByRole("listitem").filter({ hasText: new RegExp(`^${label}`) });
    await expect(tile("ET dates traded")).toContainText("ET dates traded: 1");
    // The trade is a win ("1 of 1 trade") or a loss ("0 of 1 trade"). The lookahead rejects the plural.
    await expect(tile("Win rate")).toContainText(new RegExp(`${read.thread.stats.wins} of 1 trade(?!s)`));
    await expect(summary).not.toContainText(/\b1 days\b/);
  });
});
