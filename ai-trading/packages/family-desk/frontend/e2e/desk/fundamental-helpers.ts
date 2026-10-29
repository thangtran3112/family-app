import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect } from "./helpers";

// The Fundamental lane's E2E world (02n §j). The seeded e2e database has no Flex import and no option chain, so a spec that
// needs holdings, calls or research answers from the frozen contract fixtures (`lib/fixtures/desk-fundamental/api`,
// copied from the backend) instead; every other route (status, settings, the shell's own reads) still reaches the real
// backend. A spec that wants the real, empty world simply does not call `mockFundamental`.

const FIXTURES = fileURLToPath(new URL("../../lib/fixtures/desk-fundamental/api/", import.meta.url));
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as T;

/** The routes whose sources are not built yet: they answer 503 with the stub off, so no screen may ask for them (02n §e). */
export const GATED_PATHS = ["/api/desk/dashboard/fundamental", "/api/desk/futures/readings", "/api/desk/fundamental-alerts"] as const;

/** Every request this page made to a gated route; a spec asserts it is empty. */
export function watchGated(page: Page): () => string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (GATED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) seen.push(`${request.method()} ${pathname}`);
  });
  return () => [...seen];
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Answer the real Fundamental endpoints from the fixtures. `overrides` replaces one path's answer (a fixture name, or a function of the URL). */
export async function mockFundamental(
  page: Page,
  overrides: Partial<Record<"holdings" | "short-calls" | "coverage" | "income" | "brief" | "import", unknown>> = {},
) {
  await page.route(
    (url) => url.pathname.startsWith("/api/desk/") && /\/(holdings|covered-calls|research)(\/|$)/.test(url.pathname),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace("/api/desk", "");
      const symbol = url.searchParams.get("symbol")?.toUpperCase();
      if (request.method() !== "GET") {
        if (path === "/holdings/import") return json(route, overrides.import ?? fixture("holdings_import"), 202);
        return route.fallback();
      }
      if (path === "/holdings") return json(route, overrides.holdings ?? fixture(url.searchParams.get("account_id") === "2" ? "holdings_account_2" : "holdings"));
      const lots = /^\/holdings\/([A-Za-z.-]+)\/lots$/.exec(path);
      if (lots) return lots[1]!.toUpperCase() === "AAPL" ? json(route, fixture("holdings_lots_aapl")) : json(route, { symbol: lots[1]!.toUpperCase(), lots: [], short_calls: [] });
      if (path === "/covered-calls/coverage") return json(route, overrides.coverage ?? fixture("covered_calls_coverage"));
      if (path === "/covered-calls/candidates") {
        if (symbol === "KO") return json(route, fixture("covered_calls_candidates_ko"));
        return json(route, fixture(url.searchParams.get("account_id") === "2" ? "covered_calls_candidates_aapl_2" : "covered_calls_candidates_aapl_1"));
      }
      if (path === "/covered-calls/short-calls") return json(route, overrides["short-calls"] ?? fixture("covered_calls_short_calls"));
      const roll = /^\/covered-calls\/short-calls\/(\d+)\/roll$/.exec(path);
      if (roll) return json(route, fixture(roll[1] === "9" ? "covered_calls_roll_ko" : "covered_calls_roll_jnj"));
      if (path === "/covered-calls/income") return json(route, overrides.income ?? fixture(url.searchParams.get("months") === "3" ? "covered_calls_income_3" : "covered_calls_income"));
      if (path === "/research/brief") return json(route, overrides.brief ?? fixture("research_brief"));
      const research = /^\/research\/symbols\/([A-Za-z.-]+)(\/valuation|\/timeline)?$/.exec(path);
      if (research) {
        const name = research[1]!.toUpperCase();
        if (research[2] === "/valuation") return json(route, fixture(name === "NVDA" ? "research_valuation_nvda" : "research_valuation_aapl"));
        if (research[2] === "/timeline") return json(route, fixture(url.searchParams.get("kind") === "news" ? "research_timeline_ko_news" : "research_timeline_ko"));
        return json(route, fixture(name === "JNJ" ? "research_jnj" : "research_aapl"));
      }
      return route.fallback();
    },
  );
}

/** Put the browser's lane on Fundamental before the first page loads (the lane lives in localStorage, `lib/lanes.ts`); a lane the
 * person chose later stays, because the script only fills an empty slot on every later load. */
export async function startInFundamental(page: Page) {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("desk.lane") === null) window.localStorage.setItem("desk.lane", "fundamental");
  });
}

/** The text of the page's main content region. */
export const mainText = (page: Page) => page.locator("#main-content").innerText();

export { expect };
