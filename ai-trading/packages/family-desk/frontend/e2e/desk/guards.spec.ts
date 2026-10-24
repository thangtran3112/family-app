import { expect, test } from "@playwright/test";
import { bannedWordingOnScreen, orderControlsOnScreen } from "./helpers";

// The two guards every desk spec ends with must bite: a page with banned wording or an operable order control fails
// them, and the shapes the Desk really shows (a disabled broker switch, a "Save order" button) do not. This spec
// uses Playwright's own `test`, because helpers' `test` would fail it for the very pages it builds.

test("the wording guard finds each kind of banned term and ignores code blocks", async ({ page }) => {
  await page.setContent(`
    <main>
      <p>Couldn't fetch quotes · Error 503</p>
      <p>Price is null and the stream dropped; hydrate failed; undefined</p>
      <button aria-label="Poll the socket">Refresh</button>
      <pre>{"change_note": null}</pre>
    </main>`);
  const found = (await bannedWordingOnScreen(page)).map((word) => word.toLowerCase());
  for (const word of ["fetch", "error 503", "null", "stream", "hydrat", "undefined", "poll", "socket"]) {
    expect(found, word).toContain(word);
  }
  expect(found.filter((word) => word === "null")).toHaveLength(1); // the one in the <pre> is not counted
});

test("the wording guard passes the copy the Desk shows", async ({ page }) => {
  await page.setContent(`
    <main>
      <p>Market closed · showing last close</p><p>Quotes paused · last update 5 min ago</p>
      <p>Couldn't load this chart · Try again</p><p>9 of 131 · NVDA 210.99 · RSI 36.04</p>
    </main>`);
  expect(await bannedWordingOnScreen(page)).toEqual([]);
});

test("the order guard finds operable order controls by any accessible name or link", async ({ page }) => {
  await page.setContent(`
    <main>
      <button>Place order</button>
      <button aria-label="Submit a paper order">Go</button>
      <label>Place trade <input type="checkbox" role="switch" /></label>
      <a href="/orders/new">Open</a>
      <button title="Buy 100 NVDA">+</button>
      <a href="/paper">Paper</a>
    </main>`);
  expect(await orderControlsOnScreen(page)).toHaveLength(6);
});

test("the order guard lets through disabled broker rows and the controls the Desk really has", async ({ page }) => {
  await page.setContent(`
    <main>
      <label>Place orders <input type="checkbox" role="switch" disabled /></label>
      <fieldset disabled><button>Place order</button></fieldset>
      <button aria-disabled="true">Submit order</button>
      <button>Save order</button><button>Move NVDA up</button><a href="/alerts/new">New alert strategy</a>
      <p>Trading is off in the Desk · place orders in IBKR</p>
    </main>`);
  expect(await orderControlsOnScreen(page)).toEqual([]);
});
