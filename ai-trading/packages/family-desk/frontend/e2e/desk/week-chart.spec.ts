import type { Page } from "@playwright/test";
import { expect, prepareDesk, test } from "./helpers";
import { DAY_ISO, createSwingThread, enterByApi, markByApi, openNextDay, send } from "./swing-helpers";

// D-072: moving the cursor over the week review's balance-and-equity chart blanked the lines. The chart is a canvas, so
// the DOM cannot tell a live chart from a blank one: this spec counts the drawn pixels of each line colour instead.
//
// Cause: lightweight-charts 5.2 draws the hovered series above the others (`hoveredSeriesOnTop`, on by default). The
// week shading is a full-height opaque histogram, so wherever the cursor was not near a line the shading was the
// hovered series, moved to the top, and painted over both lines.

const CHART = "section[aria-label='Balance and equity 1d market chart']";
const EQUITY_AMBER = [0xff, 0xb0, 0x20] as const;
const BALANCE_GREY = [0xe5, 0xe5, 0xea] as const;

/** Pixels of each line colour on the chart's pane canvas (the first canvas the library makes: grid, shading and series). */
async function linePixels(page: Page) {
  return page.evaluate(({ chart, amber, grey }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`${chart} canvas`)!;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const near = (i: number, [r, g, b]: readonly number[]) =>
      data[i + 3]! > 0 && Math.abs(data[i]! - r!) < 12 && Math.abs(data[i + 1]! - g!) < 12 && Math.abs(data[i + 2]! - b!) < 12;
    let equity = 0;
    let balance = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (near(i, amber)) equity++;
      else if (near(i, grey)) balance++;
    }
    return { size: `${canvas.width}x${canvas.height}`, equity, balance };
  }, { chart: CHART, amber: EQUITY_AMBER, grey: BALANCE_GREY });
}

test.describe("Week review chart", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the balance and equity lines stay drawn, with no console error, while the cursor moves over the chart", async ({ page, context }) => {
    test.setTimeout(180_000);
    // The same week as the Week 1 review spec: two holds, so balance and equity differ and both lines have a shape.
    const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
    const dayOne = await openNextDay(context, threadId);
    await enterByApi(context, dayOne, { symbol: "S01", watch: ["S01", "S04"], day: DAY_ISO[0]!, stopPrice: 95 });
    await markByApi(context, dayOne, "S04", { kind: "long_entry", shares: 100 });
    await send(context, "POST", `/day-lists/${dayOne}/end`);
    for (let day = 2; day <= 5; day++) {
      const list = await openNextDay(context, threadId);
      if (day === 4) await markByApi(context, list, "S01", { kind: "long_exit" }, { day: DAY_ISO[3]!, to: "09:35" });
      await send(context, "POST", `/day-lists/${list}/end`);
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => message.type() === "error" && errors.push(`console.error: ${message.text()}`));

    await page.goto(`/practice/week?thread=${threadId}&week=1`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Week 1 · 5 days");
    await expect.poll(async () => (await linePixels(page)).equity, { message: "the equity line is drawn before the hover" }).toBeGreaterThan(500);
    const before = await linePixels(page);
    expect(before.balance).toBeGreaterThan(500);

    const box = (await page.locator(`${CHART} canvas`).first().boundingBox())!;
    expect(box.width).toBeGreaterThan(300);
    expect(box.height).toBeGreaterThan(150);
    // Away from both lines (they sit near the top and the bottom of the pane): the shading, not a line, is under the cursor.
    for (const [x, y] of [[0.5, 0.35], [0.3, 0.6], [0.7, 0.8]] as const) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
      await page.waitForTimeout(300);
      const during = await linePixels(page);
      expect(during.size, `canvas size at (${x}, ${y})`).toBe(before.size);
      expect(during.equity, `equity line pixels at (${x}, ${y})`).toBeGreaterThan(before.equity * 0.9);
      expect(during.balance, `balance line pixels at (${x}, ${y})`).toBeGreaterThan(before.balance * 0.9);
    }
    expect(errors).toEqual([]);
  });
});
