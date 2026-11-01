import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { BANNED_TERMS } from "../../lib/desk/freshness.ts";
import { authenticate, origin, prepare } from "../helpers";

// The Technical desktop MVP's E2E world (02m §d5). Every spec in this folder imports `test` from here: it
// runs `expectCleanScreen` and the no-order-request check after the spec's own steps, so no spec can finish
// on a screen that shows banned wording or an order control. Specs also call `expectCleanScreen` after each
// screen they open.

/** `technical`: seeds as shipped (all `draft`, no alert history). `technical-alerts`: after four fires. */
export type DeskSeed = "technical" | "technical-alerts";

/** Thu 2026-10-15 20:00 ET, the clock the seed is written for (`backend/tests/e2e/clock.py`). */
export const SEED_NOW = "2026-10-16T00:00:00Z";
/** Thu 2026-10-15 11:30 ET and 10:00 ET: inside the regular session, for the open-market scenarios. */
export const MIDDAY = "2026-10-15T15:30:00Z";

export async function prepareDesk(context: BrowserContext, seed: DeskSeed = "technical") {
  await prepare(context, seed);
}

/** Move the server's frozen clock and the feeds' last good update (minutes before that clock). */
export async function setScenario(
  context: BrowserContext,
  scenario: { now?: string; feedAgeMinutes?: number; feedState?: "ok" | "degraded" | "down" },
) {
  const response = await context.request.post(`${origin}/api/desk/__e2e/scenario`, {
    data: { now: scenario.now, feed_age_minutes: scenario.feedAgeMinutes, feed_state: scenario.feedState ?? "ok" },
  });
  expect(response.ok()).toBeTruthy();
}

/** Open a screen with the browser clock on the server's clock (default: `SEED_NOW`) and wait for the shell's
 * content region (`#main-content`; both shells render it as the one `main` landmark, the screens inside it come and go). */
export async function openDesk(page: Page, path: string, now: string = SEED_NOW) {
  await page.clock.setFixedTime(new Date(now));
  await page.goto(path);
  await expect(page.locator("#main-content")).toBeVisible();
}

/** Pick a mode from the top bar's mode menu (ADR-0014). The button names the current mode in full; the menu lists all three. */
export async function pickMode(page: Page, mode: "Technical" | "Fundamental" | "Backtest") {
  const top = page.locator(".dk-top");
  await top.getByRole("button", { name: /^Mode: / }).click();
  await page.getByRole("menu", { name: "Mode" }).getByRole("menuitemradio", { name: new RegExp(`^${mode}`) }).click();
  await expect(top.getByRole("button", { name: `Mode: ${mode}` })).toBeVisible();
}

/** Backtest chrome (ADR-0014): the mode button, the Practice and Journal tabs with one active, and no live-market parts in the top bar. */
export async function expectBacktestChrome(page: Page, active: "Practice" | "Journal") {
  const top = page.locator(".dk-top");
  const nav = top.getByRole("navigation", { name: "Primary navigation" });
  await expect(top.getByRole("button", { name: "Mode: Backtest" })).toBeVisible();
  await expect(nav.getByRole("link")).toHaveText(["Practice", "Journal"]);
  await expect(nav.locator("[aria-current='page']")).toHaveText([active]);
  await expect(top.getByTitle(/market|pre-market|after hours/i), "no market-status pill in Backtest").toHaveCount(0);
  await expect(top.getByRole("button", { name: /^Alerts/ })).toHaveCount(0);
  await expect(top.getByRole("combobox", { name: "Search symbols" })).toHaveCount(0);
  await expect(top.getByRole("button", { name: "Search symbols, ⌘K" })).toHaveCount(0);
}

/** Every `/api/desk/` path this page requested, so a spec can assert on what the screen asked for. */
export function watchApi(page: Page): { paths: () => string[]; clear: () => void } {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/desk/")) seen.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  return { paths: () => [...seen], clear: () => void (seen.length = 0) };
}

/** What the 02l §c3 list bans, found in the text a person sees (and reads aloud): visible text and labels.
 * Code and JSON blocks are engineering detail (a `Details` disclosure at most) and are left out. */
export async function bannedWordingOnScreen(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => {
    const code = [...document.querySelectorAll<HTMLElement>("pre, code")].map((node) => node.innerText);
    let visible = document.body.innerText;
    for (const block of code) visible = visible.replace(block, " ");
    const labels = [...document.querySelectorAll("[aria-label], [title], [placeholder], [alt]")].flatMap((node) =>
      ["aria-label", "title", "placeholder", "alt"].map((name) => node.getAttribute(name) ?? ""),
    );
    return [visible, ...labels].join("\n");
  });
  return BANNED_TERMS.flatMap((pattern) => text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? []);
}

// A control that places, previews, stages or manages an order, a position or a broker link. Technical ratings
// ("Strong Buy", "Sell") are labels, not controls, so only things a person can press or follow are scanned.
const ORDER_CONTROL =
  /\b(place|submit|send|create|new|stage|preview|confirm|cancel|modify|close)\s+(an?\s+)?(paper\s+|live\s+|limit\s+|market\s+|stop\s+|bracket\s+)?(order|trade|position)s?\b|\b(buy|sell)\s+(now|at market|market|limit|\d)|\b(market|limit|stop|bracket|paper)\s+order\b|\btrade ticket\b|\border (ticket|entry|form)\b|\b(go|get)\s+long\b|\b(go|get)\s+short\b|\bshort\s+(sell|this)\b/i;
const ORDER_TARGET = /\/(orders?|positions?|broker|trade|trading)(\/|\?|$)|\/(paper|backtests)(\/|\?|$)/i;

/** Buttons, links, inputs and menu items that look like an operable order control (empty when there is none). A control
 * that is disabled cannot place anything, so the broker rows' "Place orders" switch, which 02m §e keeps on screen
 * disabled beside the orders-off reason, passes; the Settings spec asserts that it is disabled. */
export async function orderControlsOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ control, target }) => {
      const named = (node: Element) => {
        const labelled = (node.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "");
        const labels = Array.from((node as HTMLInputElement).labels ?? []).map((label) => label.textContent ?? "");
        return [
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          (node as HTMLElement).innerText,
          node.getAttribute("name"),
          ...labelled,
          ...labels,
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      };
      const disabled = (node: Element) =>
        node.matches(":disabled") || node.getAttribute("aria-disabled") === "true" || node.closest("fieldset:disabled") !== null;
      const controls = document.querySelectorAll(
        "button, a[href], input, select, textarea, summary, [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='switch'], [role='checkbox']",
      );
      return Array.from(controls).flatMap((node) => {
        if (disabled(node)) return [];
        const href = node.getAttribute("href") ?? "";
        const text = named(node);
        const offending = new RegExp(control, "i").test(text) || (href !== "" && new RegExp(target, "i").test(href));
        return offending ? [`${node.tagName.toLowerCase()} "${text}" ${href}`.trim()] : [];
      });
    },
    { control: ORDER_CONTROL.source, target: ORDER_TARGET.source },
  );
}

// The Practice replay workspace is the one screen with an order ticket (owner decision, 2026-11-01): a broker-style ticket whose
// market, limit, stop and stop-limit entries are simulated against a replayed past day and reach no broker or account. Every other
// screen, the Practice lists and journals included, is still checked for order controls.
const PRACTICE_TICKET_SCREEN = /^\/practice\/replay\/?$/;

/** The screen shows none of the banned wording and no order control (the Practice replay workspace's own ticket aside). */
export async function expectCleanScreen(page: Page) {
  expect(await bannedWordingOnScreen(page), "banned wording on screen (02l §c3)").toEqual([]);
  if (PRACTICE_TICKET_SCREEN.test(new URL(page.url()).pathname)) return;
  expect(await orderControlsOnScreen(page), "order control on screen").toEqual([]);
}

const ORDER_REQUEST = /\/api\/desk\/[^?\s]*(order|position|broker|trade)/i;
// Reordering the symbols of a watchlist (02m endpoint 25) is the one route whose path says "order".
const REORDER_REQUEST = /^PUT \/api\/desk\/watchlists\/\d+\/order$/;
// The Practice ticket places and cancels its simulated orders here, and nowhere else (the backend route guard names the same two paths).
const PRACTICE_ORDER_REQUEST = /^(POST|DELETE) \/api\/desk\/replay\/sessions\/\d+\/orders(\/\d+)?$/;

export const test = base.extend<{ cleanDesk: void }>({
  cleanDesk: [
    async ({ page }, use) => {
      const api = watchApi(page);
      await use();
      await expectCleanScreen(page);
      expect(
        api.paths().filter((path) => ORDER_REQUEST.test(path) && !REORDER_REQUEST.test(path) && !PRACTICE_ORDER_REQUEST.test(path)),
        "order request",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { authenticate, expect, origin };
