import type { BrowserContext, Locator, Page } from "@playwright/test";
import { chartPalette } from "../../lib/desk/chartPalette.ts";
import { PRACTICE_COPY, practiceBandText, practiceText } from "../../lib/desk/freshness.ts";
import { defaultDraft, draftToSpec } from "../../lib/replay/setup.ts";
import { origin } from "../helpers";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { DAY, createStubSession } from "./hub-helpers";
import { createSwingThread, openNextDay, replayRail, send } from "./swing-helpers";

// The replay chart's full screen and settings (design-replay-chart.md §(d), fix wave 5S stream 3). The stub day is TSLA on
// Fri 2026-09-25, replayed 09:30 to 09:40 ET at one-minute bars.

const STORE_KEY = "desk.replayChart";

const legendButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) });
const chartSettings = (page: Page) => page.getByRole("button", { name: "Chart", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "Chart settings" });
const fullScreen = (page: Page) => page.getByRole("button", { name: "Full screen" });
const shell = (page: Page) => page.locator(".dk-shell");
const leftRail = (page: Page) => page.getByRole("complementary", { name: "Practice side panel" });
const headerVwap = (page: Page) => page.locator("dt", { hasText: /^VWAP$/ }).locator("xpath=following-sibling::dd");
const playhead = (page: Page) => page.getByTestId("thread-clock-time"); // the thread's one clock, in the bar above every name
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

  // The OHLC / VWAP / EMA legend was laid over the top-left of the plot and covered the candles. It is now a values bar above
  // the chart, in flow: it takes its own height, so no width can put it over a candle, a line, a level or the price scale.
  test("the legend is a values bar above the chart and overlaps no plot pixel, at the normal width and in a narrow chart", async ({ page }) => {
    await stepBars(page, 3);
    const chart = page.locator("section[aria-label='TSLA 1m market chart']");
    const area = chart.locator("xpath=..");
    const plot = chart.locator("canvas").first();
    const bar = legendButton(page, "VWAP").locator("xpath=..");
    const entries = [page.getByText(/^TSLA · 1m · O /), legendButton(page, "VWAP"), legendButton(page, "EMA 9"), legendButton(page, "EMA 21")];
    const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
      inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

    async function expectBarAbovePlot(label: string) {
      const barBox = (await bar.boundingBox())!;
      const plotBox = (await plot.boundingBox())!;
      const areaBox = (await area.boundingBox())!;
      expect(barBox.y + barBox.height, `${label}: the bar ends where the plot begins`).toBeLessThanOrEqual(plotBox.y + 0.5);
      expect(inside(barBox, areaBox), `${label}: the bar is inside the chart column`).toBe(true);
      for (const entry of entries) expect(inside((await entry.boundingBox())!, barBox), `${label}: every entry is inside the bar`).toBe(true);
      expect(inside((await chart.boundingBox())!, areaBox), `${label}: the chart stays inside its column (no clipped pane)`).toBe(true);
      // Painted, not only measured: the top-left of the plot is the chart's own canvas, and the bar's middle is the bar.
      const hit = await page.evaluate(({ plotX, plotY, barX, barY }) => ({
        plot: document.elementFromPoint(plotX, plotY)?.tagName,
        bar: document.elementFromPoint(barX, barY)?.closest("button, div")?.textContent ?? "",
      }), { plotX: plotBox.x + 4, plotY: plotBox.y + 4, barX: barBox.x + 2, barY: barBox.y + barBox.height / 2 });
      expect(hit.plot, `${label}: the plot's top-left corner is the canvas, not the legend`).toBe("CANVAS");
      expect(hit.bar).toContain("TSLA");
      const scroll = await area.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight, overX: el.scrollWidth - el.clientWidth }));
      expect(scroll.over, `${label}: no vertical scrollbar in the chart column`).toBeLessThanOrEqual(1);
      expect(scroll.overX, `${label}: no horizontal scrollbar in the chart column`).toBeLessThanOrEqual(1);
      return { barBox, plotBox };
    }

    const wide = await expectBarAbovePlot("normal width");
    // Moving the cursor over the plot rewrites the readout; the bar must not change height, or the plot would jump under it.
    await page.mouse.move(wide.plotBox.x + wide.plotBox.width / 2, wide.plotBox.y + wide.plotBox.height / 2);
    await page.mouse.move(wide.plotBox.x + wide.plotBox.width / 2 + 40, wide.plotBox.y + wide.plotBox.height / 2 + 10);
    const hovered = await expectBarAbovePlot("cursor on the plot");
    expect(hovered.barBox.height, "the bar keeps its height while the readout changes").toBeCloseTo(wide.barBox.height, 0);
    expect(hovered.plotBox.y, "the plot does not move").toBeCloseTo(wide.plotBox.y, 0);

    // A narrow chart: the entries wrap onto more rows, the bar grows, the plot still starts below it.
    await area.evaluate((el) => { (el as HTMLElement).style.width = "300px"; });
    await expect.poll(async () => (await plot.boundingBox())!.width).toBeLessThanOrEqual(300);
    const narrow = await expectBarAbovePlot("a 300 px chart");
    expect(narrow.barBox.height, "the entries wrapped").toBeGreaterThan(wide.barBox.height);

    // A hidden overlay stays listed, still a button, with its text at full contrast (it used to be dimmed to about 2.8:1).
    await area.evaluate((el) => { (el as HTMLElement).style.width = ""; });
    await legendButton(page, "EMA 21").click();
    await expect(legendButton(page, "EMA 21")).toHaveAttribute("aria-pressed", "false");
    const ratio = await legendButton(page, "EMA 21").evaluate((button) => {
      const channel = (value: number) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const luminance = (css: string) => { const [r, g, b] = css.match(/[\d.]+/g)!.map(Number); return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!); };
      const text = getComputedStyle(button.querySelector("span:last-child")!);
      const ground = getComputedStyle(button.parentElement!).backgroundColor;
      const [hi, lo] = [luminance(text.color), luminance(ground)].sort((a, b) => b - a);
      return { ratio: (hi! + 0.05) / (lo! + 0.05), opacity: Number(getComputedStyle(button).opacity) };
    });
    expect(ratio.opacity, "the whole button is not dimmed").toBe(1);
    expect(ratio.ratio, "the hidden entry's value against the bar").toBeGreaterThanOrEqual(4.5);
  });

  // A trackpad pinch reaches the page as ctrl+wheel events of a few px each. lightweight-charts' own handler turned 30 of them
  // (2 px) into a 1.06x zoom; the chart now takes them at the fingers' pace (about 1.8x), anchored under the cursor.
  test("a trackpad pinch (ctrl+wheel, 2 px an event) zooms the chart at the fingers' pace, not a tenth of it", async ({ page }) => {
    await stepBars(page, 3);
    const plot = page.locator("section[aria-label='TSLA 1m market chart'] canvas").first();
    const box = (await plot.boundingBox())!;
    // Candle pixels (up and down colours) grow with the bar width, so they tell a 1.8x zoom from a 1.06x one.
    const candlePixels = () => plot.evaluate((canvas: HTMLCanvasElement, colours: string[]) => {
      const rgb = colours.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && rgb.some(([r, g, b]) => Math.abs(data[i]! - r!) < 12 && Math.abs(data[i + 1]! - g!) < 12 && Math.abs(data[i + 2]! - b!) < 12)) count++;
      return count;
    }, [chartPalette.up, chartPalette.down]);
    const before = await candlePixels();
    expect(before).toBeGreaterThan(200);
    const pinch = await page.evaluate(async ({ x, y }) => {
      const target = document.elementFromPoint(x, y)!;
      let prevented = 0;
      for (let i = 0; i < 30; i++) {
        const event = new WheelEvent("wheel", { deltaY: -2, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        if (event.defaultPrevented) prevented++;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { tag: target.tagName, prevented };
    }, { x: box.x + box.width * 0.75, y: box.y + box.height / 2 });
    expect(pinch).toEqual({ tag: "CANVAS", prevented: 30 });
    await expect.poll(candlePixels, { message: "30 pinch events of 2 px zoom the candles in by well over the library's 1.06x" }).toBeGreaterThan(before * 1.3);
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

  test("F hides the left rail and the shell bars but keeps the tape, the thread clock and the amber band; Escape returns", async ({ page }) => {
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

  test("the popover sits inside the window, above the chart toolbar, and its controls are named", async ({ page }) => {
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

/** A stub session whose plan asks for a stop on every entry (the API takes the plan in the session spec). */
async function createStopRequiredSession(context: BrowserContext): Promise<number> {
  const spec = draftToSpec({ ...defaultDraft(), symbol: "TSLA", day: DAY, to: "09:40", interval: "1m" }) as { plan: Record<string, unknown> };
  const response = await context.request.post(`${origin}/api/desk/replay/sessions`, { data: { ...spec, plan: { ...spec.plan, stopRequired: "yes" } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: number }).id;
}

test.describe("Practice replay: header, controls and ended session (R-02, R-04, R-05, R-06)", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  // D-100: after End day the review shows the date, but the replay still said "Hidden day" and offered Show date.
  test("an ended session's replay shows its date and drops the Hidden day chip, the banner and Show date (R-04)", async ({ page, context }) => {
    const id = await createStubSession(context, { dayHidden: true });
    await openReplay(page, id);
    await expect(page.getByText(PRACTICE_COPY.bandHiddenWhy)).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.showDate })).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.hiddenDay, { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(DAY);

    const ended = await context.request.post(`${origin}/api/desk/replay/sessions/${id}/end`);
    expect(ended.ok(), await ended.text()).toBeTruthy();
    await openDesk(page, `/practice/replay?id=${id}`);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expect(page.getByText(PRACTICE_COPY.bandHiddenWhy)).toHaveCount(0);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.showDate })).toHaveCount(0);
    await expect(page.getByText(PRACTICE_COPY.hiddenDay, { exact: true })).toHaveCount(0);
    await expect(page.locator("h1").locator("xpath=..")).toContainText(/2026-09-25/);
  });

  // D-101, reworked: the ticket's fields are named by a real label link, and a plan that asks for a stop never disables or warns on Buy or Sell.
  test("the ticket's fields are named by a label link, and a plan that asks for a stop never disables Buy or Sell (R-05)", async ({ page, context }) => {
    const id = await createStopRequiredSession(context);
    await openReplay(page, id);
    const practice = await replayRail(page, "Practice");
    const quantity = practice.getByRole("textbox", { name: "Quantity" });
    const quantityId = await quantity.getAttribute("id");
    expect(quantityId, "the Quantity input has an id").toBeTruthy();
    await expect(page.locator(`label[for="${quantityId}"]`)).toContainText("Quantity");
    const orderType = practice.getByRole("combobox", { name: "Order type" });
    const typeId = await orderType.getAttribute("id");
    expect(typeId, "the Order type select has an id").toBeTruthy();
    await expect(page.locator(`label[for="${typeId}"]`)).toContainText("Order type");

    // A market ticket asks for nothing but a side and a quantity: no stop field, no hint, nothing waiting on one.
    await expect(practice.getByRole("textbox", { name: /stop/i })).toHaveCount(0);
    await expect(practice.getByRole("textbox", { name: /limit/i })).toHaveCount(0);
    const buy = practice.getByRole("button", { name: "Buy" });
    await expect(buy).toBeEnabled();
    await expect(buy).toHaveAccessibleDescription("Buy 100 TSLA · Market");
    await practice.getByRole("radio", { name: "Sell" }).click();
    await expect(practice.getByRole("button", { name: "Sell" })).toBeEnabled();
    await expect(practice.getByRole("radio", { name: "Sell" })).toBeChecked();
  });

  // The broker ticket (owner directive): each order type shows exactly the price fields it needs, and Bracket is named but not offered.
  test("the order type picks the price fields: Market none, Limit a limit, Stop a stop, Stop-limit both, Bracket is not simulated", async ({ page, context }) => {
    await openReplay(page, await createStubSession(context));
    const practice = await replayRail(page, "Practice");
    const orderType = practice.getByRole("combobox", { name: "Order type" });
    const fields = async () => ({
      limit: await practice.getByRole("textbox", { name: "Limit price" }).count(),
      stop: await practice.getByRole("textbox", { name: "Stop price" }).count(),
    });
    expect(await fields()).toEqual({ limit: 0, stop: 0 });
    for (const [type, expected] of [["limit", { limit: 1, stop: 0 }], ["stop", { limit: 0, stop: 1 }], ["stop_limit", { limit: 1, stop: 1 }], ["market", { limit: 0, stop: 0 }]] as const) {
      await orderType.selectOption(type);
      expect(await fields(), type).toEqual(expected);
    }
    await expect(orderType.locator("option", { hasText: "Bracket" })).toBeDisabled();
    await expect(orderType.locator("option", { hasText: "Bracket" })).toHaveText("Bracket · not simulated yet");
    await expect(practice.getByRole("textbox", { name: /target/i })).toHaveCount(0);
  });

  test("the Practice panel carries one honest footnote about replayed prices (R-06)", async ({ page, context }) => {
    await openReplay(page, await createStubSession(context));
    const practice = await replayRail(page, "Practice");
    await expect(practice.getByText(PRACTICE_COPY.priceFootnote)).toBeVisible();
  });

  // D-146: the header wrapped when P/L widened, and the End confirm shrank the plot.
  test("the chart keeps its place and size when P/L widens and when the End confirm opens (R-02)", async ({ page, context }) => {
    await openReplay(page, await createStubSession(context));
    const chart = page.locator("section[aria-label='TSLA 1m market chart']");
    const before = (await chart.boundingBox())!;
    // The player's state is the thread's, not the name's: its pill is in the thread bar, never in the ticker header.
    const heading = page.getByRole("heading", { name: "TSLA", level: 1 });
    const bar = page.getByTestId("thread-clock");
    await expect(bar.locator("[data-state]")).toBeVisible();
    await expect(page.locator("div[class*='header']").filter({ has: heading }).locator("[data-state]")).toHaveCount(0);
    const barBefore = (await bar.boundingBox())!;

    await stepBars(page, 2);
    await page.keyboard.press("b");
    await stepBars(page, 3);
    const widened = (await chart.boundingBox())!;
    expect(widened.y, "the chart top does not move when P/L changes").toBeCloseTo(before.y, 0);
    expect((await bar.boundingBox())!.height, "the thread bar keeps its height as the clock and the state change").toBeCloseTo(barBefore.height, 0);
    // (The Marks panel opens by itself on the first mark and changes the chart's height: returned to the owner, not part of this check.)

    await page.getByRole("button", { name: "End session…" }).click();
    const confirm = page.getByRole("group", { name: "Confirm ending the session" });
    await expect(confirm).toBeVisible();
    const open = (await chart.boundingBox())!;
    expect(open.height, "the confirm opens over the chart, it does not shrink it").toBeCloseTo(widened.height, 0);
    const box = (await confirm.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await confirm.getByRole("button", { name: "Keep practicing" }).click();
    await expect(confirm).toHaveCount(0);
  });
});

test.describe("Practice replay chart in a swing session (the Daily view)", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the type applies to the Daily chart; the intraday groups are switched off and say why", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await createSwingThread(context);
    const dayOne = await openNextDay(context, threadId);
    await send(context, "PATCH", `/day-lists/${dayOne}`, { watch: ["S01"] });
    const session = await send(context, "POST", `/day-lists/${dayOne}/sessions`, { symbol: "S01" });
    await openDesk(page, `/practice/replay?id=${session.id}`);
    await expect(page.getByRole("heading", { name: "S01", level: 1 })).toBeVisible();

    await chartSettings(page).click();
    await expect(popover(page).getByRole("checkbox", { name: "VWAP" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await page.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: "Daily", exact: true }).click();
    await expect(page.getByRole("region", { name: "S01 1d market chart" })).toBeVisible();

    await chartSettings(page).click();
    await expect(popover(page).getByText("The daily view has no intraday lines.")).toBeVisible();
    for (const name of ["VWAP", "EMA 9", "EMA 21", "Volume", "Prior close", "Session high and low", "Opening range (first 15 min)"]) {
      await expect(popover(page).getByRole("checkbox", { name }), name).toBeDisabled();
    }
    await popover(page).getByRole("radio", { name: "Area" }).check();
    await expect(popover(page).getByRole("radio", { name: "Area" })).toBeChecked();
    await expect(page.getByRole("region", { name: "S01 1d market chart" })).toBeVisible();
    expect(await page.locator("section[aria-label='S01 1d market chart'] canvas").count()).toBeGreaterThan(0);
  });
});
