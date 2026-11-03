import type { Page } from "@playwright/test";
import { chartPalette } from "../../lib/desk/chartPalette.ts";
import { stepBar } from "./clock-helpers";
import { expect, prepareDesk, test } from "./helpers";
import { openNameFromScreen } from "./lane-helpers";

// D-195: a lane's chart that is open while the thread's clock moves follows the newest bars, with its time-axis labels, on every update, as it
// does on a load. The chart has no Step of its own; the market moves through the thread's clock route (what Play, and Pause in
// another window, end up calling), and the chart on screen follows it. The stub day is TSLA on Fri 2026-09-25 from 09:30 ET at one-minute bars.

// The stub day replays TSLA's bars for three more names at a fraction of the price. XOM is opened by no other spec on its own, and the server keeps
// the prepared bars of every name it has served: a lane opened on a name that an earlier spec's lane had already drawn shows that lane's.
const SYMBOL = "XOM";

type Reading = { candleLeft: number; candleRight: number; axisInkRight: number };

/** Where the candles are on the plot (leftmost and rightmost column that holds a candle body or wick, as a share of the plot's width) and how much label ink the right half of the time axis carries. */
async function readChart(page: Page): Promise<Reading> {
  const chart = page.locator("section[aria-label$='market chart']").first();
  return chart.evaluate((section, colours) => {
    const canvases = [...section.querySelectorAll("canvas")];
    const plot = canvases[0]!;
    const plotBox = plot.getBoundingClientRect();
    const axis = canvases.find((canvas) => {
      const box = canvas.getBoundingClientRect();
      return box.top >= plotBox.bottom - 1 && box.width >= plotBox.width - 2;
    })!;
    const pixels = (canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    const [[ur, ug, ub], [dr, dg, db]] = colours.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))) as [number[], number[]];
    const near = (data: Uint8ClampedArray, i: number) => data[i + 3]! > 0 && ((Math.abs(data[i]! - ur!) < 12 && Math.abs(data[i + 1]! - ug!) < 12 && Math.abs(data[i + 2]! - ub!) < 12) || (Math.abs(data[i]! - dr!) < 12 && Math.abs(data[i + 1]! - dg!) < 12 && Math.abs(data[i + 2]! - db!) < 12));
    // A candle is a vertical run of its colour (a wick is 1 px wide, a body wider); the last-price line is a horizontal dotted run and is not one.
    const { width, height, data } = pixels(plot as HTMLCanvasElement);
    let left = -1;
    let right = -1;
    for (let x = 0; x < width; x++) {
      let run = 0;
      for (let y = 0; y < height; y++) {
        run = near(data, (y * width + x) * 4) ? run + 1 : 0;
        if (run >= 4) {
          if (left < 0) left = x;
          right = x;
          break;
        }
      }
    }
    const ink = pixels(axis as HTMLCanvasElement);
    let axisInkRight = 0;
    for (let y = 0; y < ink.height; y++) {
      for (let x = Math.floor(ink.width / 2); x < ink.width; x++) {
        const i = (y * ink.width + x) * 4;
        if (ink.data[i + 3]! > 0 && ink.data[i]! + ink.data[i + 1]! + ink.data[i + 2]! > 3 * 110) axisInkRight++;
      }
    }
    return { candleLeft: left < 0 ? -1 : left / width, candleRight: right < 0 ? -1 : right / width, axisInkRight };
  }, [chartPalette.up, chartPalette.down]);
}

test("a lane's chart open while the thread clock moves keeps its newest bars across the plot, with the time-axis labels, on every update (D-195)", async ({ page, context }) => {
  test.setTimeout(240_000);
  await prepareDesk(context);
  await openNameFromScreen(page, context, SYMBOL);

  // 9:30, before the open: no session bar yet, so the chart waits at the session's first bar (D-099, D-186): the lookback is a sliver at the left edge.
  await expect.poll(async () => (await readChart(page)).candleRight, { message: "waits at the open: nothing but a sliver of lookback at the left edge", timeout: 20_000 }).toBeLessThan(0.1);

  // 9:31 to 9:34: each bar the clock reveals moves the view to it at once. The newest bar sits near the right edge with the lookback to its left
  // (it read 30 to 40 % of the plot, bunched on the left, with the labels behind it, before the fix).
  for (let bar = 1; bar <= 4; bar += 1) {
    await stepBar(page);
    await expect.poll(async () => (await readChart(page)).candleRight, { message: `bar ${bar}: the newest candle is near the right edge`, timeout: 20_000 }).toBeGreaterThan(0.8);
    const reading = await readChart(page);
    expect(reading.candleLeft, `bar ${bar}: the candles run in from the left edge`).toBeLessThan(0.2);
    expect(reading.axisInkRight, `bar ${bar}: the right half of the time axis carries labels`).toBeGreaterThan(50);
  }
});
