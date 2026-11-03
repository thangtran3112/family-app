import { test, expect, prepareDesk, openDesk, setScenario, MIDDAY } from "./helpers";
import { mockFundamental, startInFundamental } from "./fundamental-helpers";

// D-211 / D-107 / D-076: the two top-bar pills keep their whole sentence at both bands, in both modes, market closed and open.
// The text sits in `.label` (overflow hidden, ellipsis): a label whose scrollWidth passes its box is cut.
test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

const FUNDAMENTAL = ["/stocks", "/holdings", "/covered-calls", "/ask"];
const TECHNICAL = ["/", "/screener", "/watchlists", "/alerts"];

async function pillBoxes(page: import("@playwright/test").Page) {
  return page.locator(".dk-top").evaluate((bar) =>
    [...bar.querySelectorAll<HTMLElement>("span[data-variant]")].map((chip) => {
      const label = chip.querySelector<HTMLElement>("span:last-child")!;
      return { text: label.textContent ?? "", box: Math.round(label.clientWidth), textWidth: label.scrollWidth, ellipsis: getComputedStyle(label).textOverflow === "ellipsis" && label.scrollWidth > label.clientWidth };
    }),
  );
}

for (const [mode, routes] of [["fundamental", FUNDAMENTAL], ["technical", TECHNICAL]] as const) {
  for (const [name, now, scenario] of [["closed", undefined, {}], ["open", MIDDAY, { now: MIDDAY, feedAgeMinutes: 0 }]] as const) {
    test(`${mode} top bar, market ${name}: both pills show their whole sentence`, async ({ page, context }) => {
      if (mode === "fundamental") {
        await startInFundamental(page);
        await mockFundamental(page);
      }
      if (now) await setScenario(context, scenario);
      for (const route of routes) {
        await openDesk(page, route, now);
        await expect(page.locator(".dk-top").locator("span[data-variant]")).toHaveCount(2);
        await expect(page.locator(".dk-top").getByRole("status")).not.toHaveText(/Checking|…/);
        const pills = await pillBoxes(page);
        console.log(`${test.info().project.name} ${mode} ${name} ${route}: ${pills.map((p) => `"${p.text}" box ${p.box} text ${p.textWidth}`).join(" | ")}`);
        // Nothing else gives: the bar itself does not overflow, and the account menu stays inside the window.
        const fit = await page.locator(".dk-top").evaluate((bar) => ({ over: bar.scrollWidth - bar.clientWidth, avatarRight: Math.round(bar.querySelector("button[aria-label='Account menu']")!.getBoundingClientRect().right), width: window.innerWidth }));
        expect(fit.over, `${route} top bar overflows`).toBeLessThanOrEqual(0);
        expect(fit.avatarRight, `${route} account menu is pushed off the window`).toBeLessThanOrEqual(fit.width);
        for (const pill of pills) expect(pill.ellipsis, `${route} "${pill.text}" is cut: box ${pill.box} < text ${pill.textWidth}`).toBe(false);
      }
    });
  }
}

// The badge no longer shrinks, so its longest wording must still fit the bar beside the Fundamental chrome.
test("fundamental top bar, quotes paused: the longest badge fits and the bar does not overflow", async ({ page, context }) => {
  await startInFundamental(page);
  await mockFundamental(page);
  await setScenario(context, { now: MIDDAY, feedAgeMinutes: 90 });
  await openDesk(page, "/stocks", MIDDAY);
  await expect(page.locator(".dk-top").getByRole("status")).toContainText("Quotes paused · last update ");
  const [badge] = (await pillBoxes(page)).slice(1);
  console.log(`${test.info().project.name} paused: "${badge!.text}" box ${badge!.box} text ${badge!.textWidth}`);
  expect(badge!.ellipsis, `"${badge!.text}" is cut`).toBe(false);
  const over = await page.locator(".dk-top").evaluate((bar) => bar.scrollWidth - bar.clientWidth);
  expect(over, "top bar overflows").toBeLessThanOrEqual(0);
});
