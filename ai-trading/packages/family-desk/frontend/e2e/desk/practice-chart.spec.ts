import type { Locator, Page } from "@playwright/test";
import { practiceText } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { createStubSession } from "./hub-helpers";

// The replay chart's full screen and settings (design-replay-chart.md §(d), fix wave 5S stream 3). The stub day is TSLA on
// Fri 2026-09-25, replayed 09:30 to 09:40 ET at one-minute bars.

const STORE_KEY = "desk.replayChart";

const legendButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) });
const chartSettings = (page: Page) => page.getByRole("button", { name: "Chart ▾" });
const popover = (page: Page) => page.getByRole("dialog", { name: "Chart settings" });
const fullScreen = (page: Page) => page.getByRole("button", { name: "Full screen" });
const shell = (page: Page) => page.locator(".dk-shell");
const leftRail = (page: Page) => page.getByRole("complementary", { name: "Practice side panel" });
const headerVwap = (page: Page) => page.locator("dt", { hasText: /^VWAP$/ }).locator("xpath=following-sibling::dd");
const playhead = (page: Page) => page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd");
const chartWidth = async (page: Page) => (await page.locator("section[aria-label='TSLA 1m market chart']").boundingBox())!.width;

async function openReplay(page: Page, id: number) {
  await openDesk(page, `/practice/replay?id=${id}`);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
}

/** Reveal a few bars so VWAP, the EMAs and the OHLC readout have values. */
async function stepBars(page: Page, count: number) {
  for (let step = 0; step < count; step++) {
    const before = await playhead(page).innerText();
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await expect(playhead(page)).not.toHaveText(before);
  }
}

test.describe("Practice replay chart: full screen and settings", () => {
  let sessionId: number;
  test.beforeEach(async ({ context, page }) => {
    await prepareDesk(context);
    sessionId = await createStubSession(context);
    await openReplay(page, sessionId);
  });

  test("hiding EMA 21 from the legend survives a reload, and the header VWAP stays with VWAP hidden", async ({ page }) => {
    await stepBars(page, 3);
    const ema21 = legendButton(page, "EMA 21");
    await expect(ema21).toHaveAttribute("aria-pressed", "true");
    await ema21.click();
    await expect(ema21).toHaveAttribute("aria-pressed", "false");
    await expect(ema21).toContainText("hidden");
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), STORE_KEY))!).on.ema21).toBe(false);

    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(legendButton(page, "EMA 21")).toHaveAttribute("aria-pressed", "false");
    await expect(legendButton(page, "EMA 9")).toHaveAttribute("aria-pressed", "true");

    // The header reads VWAP from the series the chart is built from: hiding the line must not blank it.
    await stepBars(page, 2);
    await expect(headerVwap(page)).toHaveText(/^\d/);
    await legendButton(page, "VWAP").click();
    await expect(legendButton(page, "VWAP")).toHaveAttribute("aria-pressed", "false");
    await expect(headerVwap(page)).toHaveText(/^\d/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the type switch redraws the same bars and the legend still shows O H L C in Line and Area", async ({ page }) => {
    await stepBars(page, 3);
    const title = page.getByText(/^TSLA · 1m · O [\d.,]+ H [\d.,]+ L [\d.,]+ C [\d.,]+$/);
    await expect(title).toBeVisible();
    await chartSettings(page).click();
    await expect(popover(page)).toBeVisible();
    const types = ["Candles", "Hollow", "Bars", "Line", "Area"];
    await expect(popover(page).getByRole("radio")).toHaveCount(types.length);
    for (const type of ["Line", "Area", "Bars", "Hollow", "Candles"]) {
      await popover(page).getByRole("radio", { name: type }).check();
      await expect(popover(page).getByRole("radio", { name: type })).toBeChecked();
      await expect(title, `the OHLC readout in ${type}`).toBeVisible();
    }
    // Six bars later the chart still draws (the series swap kept the data and the zoom).
    await popover(page).getByRole("radio", { name: "Line" }).check();
    await page.keyboard.press("Escape");
    await stepBars(page, 3);
    await expect(title).toBeVisible();
    expect(await page.locator("section[aria-label='TSLA 1m market chart'] canvas").count()).toBeGreaterThan(0);
  });

  test("the choices persist: type and a level toggle come back after a reload", async ({ page }) => {
    await chartSettings(page).click();
    await popover(page).getByRole("radio", { name: "Line" }).check();
    await popover(page).getByRole("checkbox", { name: "Prior close" }).uncheck();
    await popover(page).getByRole("checkbox", { name: "Volume" }).uncheck();
    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await chartSettings(page).click();
    await expect(popover(page).getByRole("radio", { name: "Line" })).toBeChecked();
    await expect(popover(page).getByRole("checkbox", { name: "Prior close" })).not.toBeChecked();
    await expect(popover(page).getByRole("checkbox", { name: "Volume" })).not.toBeChecked();
    await expect(popover(page).getByRole("checkbox", { name: "Session high and low" })).toBeChecked();
    await popover(page).getByRole("button", { name: "Reset to defaults" }).click();
    await expect(popover(page).getByRole("radio", { name: "Candles" })).toBeChecked();
    await expect(popover(page).getByRole("checkbox", { name: "Prior close" })).toBeChecked();
  });

  test("a stored value that is broken falls back to the default chart instead of breaking it", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, '{"v":1,"type":"zigzag","on":{"vwap":"no","ema21":false}}'), STORE_KEY);
    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(legendButton(page, "VWAP")).toHaveAttribute("aria-pressed", "true");
    await expect(legendButton(page, "EMA 21")).toHaveAttribute("aria-pressed", "false");
    await chartSettings(page).click();
    await expect(popover(page).getByRole("radio", { name: "Candles" })).toBeChecked();
  });

  test("F hides the left rail and the shell bars but keeps the tape, the transport and the amber band; Escape returns", async ({ page }) => {
    const url = page.url();
    const inlineWidth = await chartWidth(page);
    await expect(leftRail(page)).toBeVisible();
    await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "false");

    await page.keyboard.press("f");
    await expect(shell(page)).toHaveAttribute("data-focus", "chart");
    await expect(fullScreen(page)).toHaveAttribute("aria-pressed", "true");
    await expect(leftRail(page)).toBeHidden();
    await expect(page.locator(".dk-top")).toBeHidden();
    await expect(page.locator(".dk-status")).toBeHidden();
    await expect(page.getByRole("status", { name: "Practice" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(page.locator(".dk-right")).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to practice/ }), "the chart workspace drops its back link while it fills the window").toHaveCount(0);
    expect(await chartWidth(page), "the chart gets the room the rail and the bars gave up").toBeGreaterThan(inlineWidth + 100);
    expect(page.url(), "full screen is a view state: no navigation").toBe(url);

    await page.keyboard.press("Escape");
    await expect(shell(page)).not.toHaveAttribute("data-focus", /.+/);
    await expect(leftRail(page)).toBeVisible();
    await expect(page.locator(".dk-top")).toBeVisible();
    expect(Math.abs((await chartWidth(page)) - inlineWidth)).toBeLessThan(2);
    expect(page.url()).toBe(url);

    // The button works the same way, and F again leaves.
    await fullScreen(page).click();
    await expect(shell(page)).toHaveAttribute("data-focus", "chart");
    await expect(fullScreen(page)).toBeFocused();
    await page.keyboard.press("f");
    await expect(shell(page)).not.toHaveAttribute("data-focus", /.+/);
  });

  test("the workspace never links to /technicals, inline or in full screen (the live chart would show the rest of the day)", async ({ page }) => {
    const technicals = page.locator("#main-content a[href*='technicals'], .dk-right a[href*='technicals']");
    await expect(technicals).toHaveCount(0);
    await page.keyboard.press("f");
    await expect(shell(page)).toHaveAttribute("data-focus", "chart");
    await expect(technicals).toHaveCount(0);
  });

  test("Escape closes the innermost layer first: the settings popover, then full screen", async ({ page }) => {
    await page.keyboard.press("f");
    await page.keyboard.press("c");
    await expect(popover(page)).toBeVisible();
    await expect(popover(page).getByRole("radio", { name: "Candles" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(shell(page)).toHaveAttribute("data-focus", "chart");
    await expect(chartSettings(page)).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(shell(page)).not.toHaveAttribute("data-focus", /.+/);
  });

  test("the popover keeps its keys: an arrow on the type or Space on a checkbox never steps or plays the replay", async ({ page }) => {
    await stepBars(page, 1);
    const at = await playhead(page).innerText();
    await page.keyboard.press("c");
    await expect(popover(page).getByRole("radio", { name: "Candles" })).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(popover(page).getByRole("radio", { name: "Hollow" })).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(popover(page).getByRole("checkbox", { name: "VWAP" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(popover(page).getByRole("checkbox", { name: "VWAP" })).not.toBeChecked();
    await page.keyboard.press("1"); // a speed key is the popover's too while focus is inside it

    await expect(playhead(page)).toHaveText(at);
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(chartSettings(page)).toBeFocused();
    await page.keyboard.press("ArrowRight"); // outside the popover the arrow steps again
    await expect(playhead(page)).not.toHaveText(at);
  });

  test("a press outside closes the popover", async ({ page }) => {
    await chartSettings(page).click();
    await expect(popover(page)).toBeVisible();
    await page.getByRole("heading", { name: "TSLA", level: 1 }).click();
    await expect(popover(page)).toHaveCount(0);
  });

  test("the popover sits inside the window, above the transport row, and its controls are named", async ({ page }) => {
    await chartSettings(page).click();
    const box = (await popover(page).boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x, "left edge").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "right edge").toBeLessThanOrEqual(view.width);
    expect(box.y, "top edge").toBeGreaterThanOrEqual(0);
    const button = (await chartSettings(page).boundingBox())!;
    expect(box.y + box.height, "opens upward from the button").toBeLessThanOrEqual(button.y + 1);
    await expect(chartSettings(page)).toHaveAttribute("aria-expanded", "true");
    await expect(chartSettings(page)).toHaveAttribute("aria-haspopup", "dialog");
    await expect(popover(page).getByRole("group", { name: "Type" })).toBeVisible();
    await expect(popover(page).getByRole("group", { name: "Overlays" })).toBeVisible();
    await expect(popover(page).getByRole("group", { name: "Levels" })).toBeVisible();
    await expect(popover(page).getByText("The practice stop and your marks always show.")).toBeVisible();
    await expectNoClip(popover(page));
  });
});

/** Nothing inside overflows the box sideways. */
async function expectNoClip(box: Locator) {
  expect(await box.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}
