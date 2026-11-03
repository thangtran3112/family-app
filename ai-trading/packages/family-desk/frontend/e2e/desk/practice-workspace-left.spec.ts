import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { stepBar } from "./clock-helpers";
import { expect, expectCleanScreen, prepareDesk, test } from "./helpers";
import { REPLAY_URL, createThreadByApi, placeOrder, replayRail } from "./hub-helpers";
import { backToScreen, openScreen, startLane } from "./lane-helpers";

// The replay workspace's left rail and foot (owner, 2026-11-01): the left rail is the popular technical indicators read off the bars
// shown so far; the Back link and the End day bar are gone from a lane's chart (the tab strip leads back); and Practice has no
// keyboard shortcuts at all. Later the same day (owner, 2026-11-01): the tape moved under the indicators in the left rail, the order
// ticket has the right rail to itself, and the chart view shows no portfolio (that is the Portfolio tab's). A lane is one name of a freestyle thread
// (ADR-0025): it never ends, so there is no End day anywhere. The stub day is TSLA on Fri 2026-09-25 from 09:30 ET, at one-minute bars.

const leftRail = (page: Page) => page.getByRole("complementary", { name: "Practice side panel" });
const indicators = (page: Page) => leftRail(page).getByTestId("indicators-panel");
const playhead = (page: Page) => page.getByTestId("thread-clock-time");

test.describe("Practice replay: indicators on the left, no shortcuts, no Back or End day bar", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the left rail is RSI, MACD, VWAP and the two EMAs, and the old session, plan and armed blocks are gone", async ({ page, context }) => {
    await startLane(page, context);

    const panel = indicators(page);
    await expect(panel.getByRole("heading", { name: PRACTICE_COPY.indicatorsTitle })).toBeVisible();
    await expect(panel, "it names the candle it is computed on").toContainText("1m");
    await expect(panel.getByText(PRACTICE_COPY.indicatorsFootnote)).toBeVisible();
    await expect(panel.getByRole("list", { name: "Momentum" }).getByRole("listitem")).toHaveText([/RSI \(14\)/, /MACD \(12, 26, 9\)/, /Signal/, /Histogram/]);
    await expect(panel.getByRole("list", { name: "Trend" }).getByRole("listitem")).toHaveText([/VWAP/, /EMA 9/, /EMA 21/]);
    // Every value is a number or a dash with "Warming up": nothing is filled in.
    for (const item of await panel.getByRole("listitem").all()) expect(await item.innerText()).toMatch(/\d|—/);

    for (const gone of ["Armed strategies", "Shares per trade", "Plan note", "attempt", "Symbol ·"]) await expect(leftRail(page), `the old "${gone}" block is gone`).not.toContainText(gone);
    await stepBar(page, 3);
    await expect(panel).toContainText("RSI (14)");
    await expectCleanScreen(page);
  });

  test("the left rail is the indicators on top and the tape under them; the right rail is the order ticket; the chart view shows no portfolio", async ({ page, context }) => {
    await startLane(page, context);
    await stepBar(page, 3);

    const tape = leftRail(page).getByTestId("tape-panel");
    await expect(tape.getByRole("heading", { name: "Tape" })).toBeVisible();
    await expect(tape.getByRole("table", { name: "Time and sales" })).toBeVisible();
    const [top, bottom] = [await indicators(page).boundingBox(), await tape.boundingBox()];
    expect(top!.y + top!.height, "the tape starts under the indicators").toBeLessThanOrEqual(bottom!.y + 1);
    expect(bottom!.height, "the tape keeps room to read").toBeGreaterThanOrEqual(400);

    // The right rail is the order side: the ticket (and the signals), no tape.
    const right = await replayRail(page, "Practice");
    const ticket = right.getByRole("region", { name: "Order ticket" });
    await expect(ticket).toBeVisible();
    await expect(right.getByRole("table", { name: "Time and sales" })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Replay context" }).or(page.getByRole("complementary", { name: "Replay context" }))).not.toContainText("Tape");
    if (test.info().project.name === "desktop-1440") {
      // With the tape gone from the right rail the whole ticket, its Buy button included, is on screen without scrolling it.
      const box = await ticket.boundingBox();
      expect(box!.y + box!.height, "the Buy button is in view").toBeLessThanOrEqual(page.viewportSize()!.height);
    }

    // No portfolio on a chart: not in the left rail, not in the right rail, not in a 1180 drawer tab.
    await expect(page.getByRole("region", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
    await expect(leftRail(page)).not.toContainText(PRACTICE_COPY.portfolioTitle);
    await expect(page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: PRACTICE_COPY.portfolioTitle })).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("Practice has no keyboard shortcuts: no legend, no key hints, and Space, arrows, digits and letters do nothing", async ({ page, context }) => {
    await startLane(page, context);
    await stepBar(page, 2);
    const at = await playhead(page).innerText();

    await expect(page.getByRole("group", { name: "Keyboard legend" })).toHaveCount(0);
    await expect(page.locator("#main-content [aria-keyshortcuts], .dk-left [aria-keyshortcuts], .dk-right [aria-keyshortcuts]"), "no control advertises a key").toHaveCount(0);
    await expect(page.locator("#main-content kbd, .dk-right kbd"), "no key chip on a button or under the chart").toHaveCount(0);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const key of ["b", "s", "x", "t", "n", "f", "c", "?", "Space", "ArrowRight", "Shift+ArrowRight", "1", "4", "ControlOrMeta+z"]) await page.keyboard.press(key);
    await page.waitForTimeout(1500);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Chart settings" }), "C does not open Chart settings").toHaveCount(0);
    await expect(page.locator(".dk-shell"), "F does not fill the window").not.toHaveAttribute("data-focus", /.+/);
    await expect(playhead(page), "Space and → move nothing").toHaveText(at);
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Marks" }).click();
    await expect(page.getByRole("tabpanel"), "B, S and X placed no mark").toContainText("No practice marks yet");
    await expect(page.getByRole("tabpanel")).not.toContainText(/press B/i);

    // The buttons are the controls.
    await placeOrder(page, "Buy");
    await expect(page.getByRole("tabpanel")).toContainText("Practice buy");
    await placeOrder(page, "Close position");
    await expect(page.getByRole("tabpanel")).toContainText("Practice exit");
    await expectCleanScreen(page);
  });

  test("a lane's chart has no End day or Back to the list bar; the Screen tab leads back, and the Screen has no End day either (a lane never ends: ADR-0025)", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createThreadByApi(context);
    await openScreen(page, context, threadId);
    await page.getByRole("button", { name: "Open TSLA" }).first().click();
    await page.waitForURL(REPLAY_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();

    await expect(page.getByRole("link", { name: /^Back to the (day )?list/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^End (day|session)/ })).toHaveCount(0);
    await expect(indicators(page).getByRole("list", { name: "Momentum" })).toBeVisible();
    await expect(indicators(page).getByRole("list", { name: "Trend" })).toBeVisible();
    await expectCleanScreen(page);

    await backToScreen(page);
    await expect(page.getByRole("table", { name: "Candidates" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^End (day|session)/ }), "no End day on the Screen either").toHaveCount(0);
    // The lane stays open on the Screen: it is listed with its name, and a click goes back to the same chart.
    await expect(page.getByTestId("screen-lanes").getByRole("link", { name: "Open TSLA" })).toBeVisible();
  });
});
