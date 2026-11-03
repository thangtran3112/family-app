import { test, expect } from "@playwright/test";
import { prepareDesk, openDesk } from "./helpers";

// Plain Playwright test: the shared cleanDesk guard scans /paper's Backtests link as an order target, which is not what this spec is about.

// D-210: the sample and preview screens set their markers and chart labels at 10 px, under the 11 px caps floor.
test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

for (const path of ["/paper", "/ask", "/backtests"]) {
  test(`${path} renders no text below 11 px and no value below 12 px`, async ({ page }) => {
    await openDesk(page, path);
    await expect(page.locator("#main-content")).toBeVisible();
    const sizes = await page.evaluate(() => {
      const found: { px: number; text: string }[] = [];
      for (const el of document.querySelectorAll("#main-content *")) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent?.trim()).map((n) => n.textContent!.trim()).join(" ");
        if (!own || (el as HTMLElement).offsetParent === null) continue;
        found.push({ px: parseFloat(getComputedStyle(el).fontSize), text: own.slice(0, 40) });
      }
      return found;
    });
    expect(sizes.length).toBeGreaterThan(10);
    expect(sizes.filter((s) => s.px < 11)).toEqual([]);
    // Chart values and year labels are not caps labels: 12 px or more.
    expect(sizes.filter((s) => /^[+-]?\d+(\.\d)?%$|^20\d\d$/.test(s.text) && s.px < 12)).toEqual([]);
    console.log(`${path} min computed font size: ${Math.min(...sizes.map((s) => s.px))} px over ${sizes.length} text nodes`);
  });
}
