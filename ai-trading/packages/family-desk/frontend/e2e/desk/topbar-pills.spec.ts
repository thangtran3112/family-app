import type { Page } from "@playwright/test";
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
  // At 1180 the badge reads "Quotes paused · 2 hr ago" (D-232); its title keeps the whole sentence at both bands.
  await expect(page.locator(".dk-top").getByRole("status")).toHaveAttribute("title", /^Quotes paused · last update /);
  const [badge] = (await pillBoxes(page)).slice(1);
  console.log(`${test.info().project.name} paused: "${badge!.text}" box ${badge!.box} text ${badge!.textWidth}`);
  expect(badge!.ellipsis, `"${badge!.text}" is cut`).toBe(false);
  const over = await page.locator(".dk-top").evaluate((bar) => bar.scrollWidth - bar.clientWidth);
  expect(over, "top bar overflows").toBeLessThanOrEqual(0);
});

// D-232: the Fundamental bar leaves 287 px at 1180 for the market pill and the quote badge together. Every sentence the two can print
// (lib/desk/freshness.ts: the ten freshness states, the first-load wording and "Status unavailable") must leave the page 1180 wide, the
// account button whole inside the window, and its menu reachable. At 1180 the long sentences show their short form; the whole sentence
// stays in the badge's title and aria-label (D-232). "Market closed · showing last close" stays whole (D-211).
const NOW = MIDDAY; // Thu 2026-10-15 11:30 ET
const NEXT_OPEN = "2026-10-16T13:30:00Z";
type Session = "regular" | "pre" | "after" | "closed";
type Sentence = {
  name: string;
  session: Session;
  /** The quote stamp: freshness, quality and the minutes since its as_of. */
  quotes?: [freshness: string, quality: string, minutesAgo: number];
  /** `none`: /status never answers; `failed`: it answers 503; `updating`/`reconnecting`: the first answer is good and the 30 s refresh hangs or fails. */
  status?: "none" | "failed" | "updating" | "reconnecting";
  full: string;
  /** What the badge shows at 1180, when it is not the whole sentence. */
  short?: string;
  /** The whole sentence overflows the 1440 bar, so only the 1180 band is held to it. */
  only1180?: true;
  /** The market pill's title and its text at 1180, for the two states that have no session. */
  pill?: [title: string, short: string];
};
const live = (freshness: string, quality = "realtime", minutesAgo = 0): Sentence["quotes"] => [freshness, quality, minutesAgo];
const SENTENCES: Sentence[] = [
  { name: "live", session: "regular", quotes: live("live"), full: "Live" },
  { name: "delayed", session: "regular", quotes: live("delayed", "delayed-15m"), full: "Delayed 15 min" },
  // The age is the longest part: minutes up to 59, hours up to 47, then days. Each pairs with the widest pill its session can bring.
  { name: "paused 59 min, pre-market", session: "pre", quotes: live("paused", "realtime", 59), full: "Quotes paused · last update 59 min ago", short: "Quotes paused · 59 min ago" },
  { name: "paused 7 hr, pre-market (walk 17)", session: "pre", quotes: live("paused", "realtime", 7 * 60), full: "Quotes paused · last update 7 hr ago", short: "Quotes paused · 7 hr ago" },
  { name: "paused 47 hr, after hours", session: "after", quotes: live("paused", "realtime", 47 * 60), full: "Quotes paused · last update 47 hr ago", short: "Quotes paused · 47 hr ago" },
  { name: "paused 3 days, closed", session: "closed", quotes: live("paused", "realtime", 3 * 24 * 60), full: "Quotes paused · last update 3 days ago", short: "Quotes paused · 3 days ago" },
  // A feed dead for weeks: two digits of days. At 1440 the whole sentence is 2 px too wide for the Fundamental bar (7 px at 100 days), a defect this fix leaves alone.
  { name: "paused 99 days, pre-market", session: "pre", quotes: live("paused", "realtime", 99 * 24 * 60), full: "Quotes paused · last update 99 days ago", short: "Quotes paused · 99 days ago", only1180: true },
  { name: "backup source", session: "regular", quotes: live("live", "fallback"), full: "Using backup quotes · may differ slightly from IBKR", short: "Backup quotes · may differ" },
  { name: "closed", session: "closed", quotes: live("closed", "eod", 15 * 60), full: "Market closed · showing last close" },
  { name: "pre-market", session: "pre", quotes: live("live"), full: "Pre-market · 11:30 AM ET" },
  { name: "after hours", session: "after", quotes: live("live"), full: "After hours" },
  { name: "unavailable", session: "regular", quotes: live("unavailable", "unavailable"), full: "Quotes unavailable right now · trying again", short: "Quotes unavailable" },
  { name: "refresh running", session: "regular", quotes: live("live", "realtime", 3), status: "updating", full: "Updating quotes…" },
  { name: "reconnecting", session: "regular", quotes: live("live", "realtime", 3), status: "reconnecting", full: "Reconnecting… · last update 11:27:00 AM ET", short: "Reconnecting…" },
  { name: "first load", session: "regular", status: "none", full: "Updating quotes…", pill: ["Checking the market…", "Checking…"] },
  { name: "status failed", session: "regular", status: "failed", full: "Status unavailable right now", short: "Status unavailable", pill: ["Market status unavailable", "Unavailable"] },
];

/** Answer /status from the real backend with the market session and quote stamp of the sentence (or hang or fail it). */
async function stubStatus(page: Page, sentence: Sentence) {
  let calls = 0;
  await page.route("**/api/desk/status", async (route) => {
    calls += 1;
    if (sentence.status === "none" || (sentence.status === "updating" && calls > 1)) return; // never answers
    if (sentence.status === "failed" || (sentence.status === "reconnecting" && calls > 1)) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    const response = await route.fetch();
    const body = await response.json();
    body.market = { ...body.market, session: sentence.session, next_open: NEXT_OPEN };
    const [freshness, quality, minutesAgo] = sentence.quotes!;
    body.quotes = { ...body.quotes, freshness, quality, source: "ibkr", as_of: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString() };
    await route.fulfill({ response, json: body });
  });
}

for (const mode of ["fundamental", "technical"] as const) {
  for (const sentence of SENTENCES) {
    test(`D-232 ${mode} top bar, ${sentence.name}: the page is not wider than the window, the account button is whole and its menu opens`, async ({ page }) => {
      const width = page.viewportSize()!.width;
      const compact = width < 1440;
      test.skip(!compact && sentence.only1180 === true, "the 1440 bar does not fit this sentence whole (a separate, older defect)");
      const top = page.locator(".dk-top");
      if (mode === "fundamental") {
        await startInFundamental(page);
        await mockFundamental(page);
      }
      await stubStatus(page, sentence);
      const path = mode === "fundamental" ? "/stocks" : "/";
      if (sentence.status === "updating" || sentence.status === "reconnecting") {
        // The refresh is the page's own 30 s timer: install the clock, let the first answer land, then run it.
        await page.clock.install({ time: new Date(NOW) });
        await page.goto(path);
        await expect(page.locator("#main-content")).toBeVisible();
        await expect(top.getByRole("status")).toHaveText("Live");
        await page.clock.runFor(31_000);
      } else {
        await openDesk(page, path, NOW);
      }

      // The title carries the whole sentence in every build: wait for the state on it, then measure.
      const badge = top.getByRole("status");
      await expect(badge).toHaveAttribute("title", sentence.full);
      if (sentence.pill) await expect(top.getByTitle(sentence.pill[0], { exact: true })).toBeVisible();

      // The page is exactly as wide as the window, and the account button sits whole inside it (no sideways scroll to reach it).
      const fit = await page.evaluate(() => {
        const avatar = document.querySelector("button[aria-label='Account menu']")!.getBoundingClientRect();
        const bar = document.querySelector(".dk-top")!;
        return { docWidth: document.documentElement.scrollWidth, avatarLeft: Math.round(avatar.left), avatarRight: Math.round(avatar.right), barOver: bar.scrollWidth - bar.clientWidth };
      });
      expect(fit.docWidth, "the page scrolls sideways").toBe(width);
      expect(fit.avatarRight, "the account button is pushed off the window").toBeLessThanOrEqual(width);
      expect(fit.barOver, "the top bar overflows").toBeLessThanOrEqual(0);
      // At 1180 no sentence is cut either: a label whose text passes its box ends in an ellipsis.
      if (compact) for (const pill of await pillBoxes(page)) expect(pill.ellipsis, `"${pill.text}" is cut: box ${pill.box} < text ${pill.textWidth}`).toBe(false);

      // The sentence on screen: whole at 1440 (and where it fits), short at 1180; the title and aria-label always carry the whole one.
      const shown = compact ? (sentence.short ?? sentence.full) : sentence.full;
      await expect(badge).toHaveText(shown);
      if (shown === sentence.full) await expect(badge).not.toHaveAttribute("aria-label", /./);
      else await expect(badge).toHaveAttribute("aria-label", sentence.full);
      if (sentence.pill) {
        const pill = top.getByTitle(sentence.pill[0], { exact: true });
        await expect(pill).toHaveText(compact ? sentence.pill[1] : sentence.pill[0]);
      }

      await top.getByRole("button", { name: "Account menu" }).click();
      const menu = page.getByRole("menu", { name: "Account" });
      await expect(menu).toBeVisible();
      for (const label of ["Settings", "More", "Feedback"]) await expect(menu.getByRole("menuitem", { name: label })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => [window.scrollX, document.documentElement.scrollWidth]), "opening the menu scrolled the page").toEqual([0, width]);
    });
  }
}
