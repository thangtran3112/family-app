import assert from "node:assert/strict";
import test from "node:test";
import { HoldingsSchema, IncomeSchema, ShortCallsSchema, type Holdings, type ShortCall } from "../api/fundamentalSchemas.ts";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import { containsBannedTerm, COPY } from "./freshness.ts";
import { daysBetween, FEED_LIMIT, incomeTile, needsYouFeed, openCallsTile, portfolioTiles, upcomingEarnings } from "./fundamentalToday.ts";
import { MASK } from "./mask.ts";

const holdings = (): Holdings => HoldingsSchema.parse(loadFundamentalFixture("holdings"));
const shortCalls = (): ShortCall[] => ShortCallsSchema.parse(loadFundamentalFixture("covered_calls_short_calls"));
const TODAY = "2026-10-23";

/** Same holdings with one symbol's earnings or ex-dividend date changed. */
function withRow(symbol: string, change: { next_earnings?: string | null; ex_dividend?: string | null }): Holdings {
  const base = holdings();
  return {
    ...base,
    rows: base.rows.map((row) =>
      row.symbol !== symbol ? row : {
        ...row,
        next_earnings: change.next_earnings === undefined ? row.next_earnings : change.next_earnings,
        fundamentals: { ...row.fundamentals, ...(change.ex_dividend === undefined ? {} : { ex_dividend: change.ex_dividend }) },
      },
    ),
  };
}

test("calendar days count across month ends", () => {
  assert.equal(daysBetween("2026-10-23", "2026-10-23"), 0);
  assert.equal(daysBetween("2026-10-28", "2026-11-04"), 7);
  assert.equal(daysBetween("2026-10-23", "2026-10-22"), -1);
});

test("the feed leads with each short-call risk, then earnings inside seven days, then the unknown ex-dividend reminder", () => {
  const feed = needsYouFeed({ holdings: holdings(), shortCalls: shortCalls(), today: TODAY });
  assert.deepEqual(feed.map((item) => item.kind), [
    "short_call_risk", "short_call_risk", "short_call_risk", // KO: the three engine risks
    "earnings_soon", "earnings_soon", // KO Oct 27 (4 days), MSFT Oct 28 (5 days)
    "ex_dividend", // AAPL and JNJ have a call and no ex-dividend date
  ]);
  assert.equal(feed[0]!.title, "Delta is above 0.50: assignment is now more likely than not");
  assert.equal(feed[0]!.detail, "KO · $72.50 call · expires Fri 2026-10-30 · 7 days left");
  assert.equal(feed[0]!.href, "/covered-calls#income");
  assert.deepEqual(feed.filter((item) => item.kind === "earnings_soon").map((item) => item.title), ["KO reports earnings in 4 days", "MSFT reports earnings in 5 days"]);
  const unknown = feed.at(-1)!;
  assert.equal(unknown.title, COPY.exDividendUnknown);
  assert.equal(unknown.detail, "AAPL, JNJ");
  assert.equal(unknown.symbol, null);
  assert.equal(feed.filter((item) => item.title === COPY.exDividendUnknown).length, 1);
});

test("earnings count from today through day seven and not before or after", () => {
  const at = (date: string | null) => upcomingEarnings(withRow("NVDA", { next_earnings: date }), TODAY, 7).map((row) => row.symbol);
  assert.deepEqual(at("2026-10-23"), ["NVDA", "KO", "MSFT"]); // today first, then by date
  assert.equal(at("2026-10-30").includes("NVDA"), true); // day 7
  assert.equal(at("2026-10-31").includes("NVDA"), false); // day 8
  assert.equal(at("2026-10-22").includes("NVDA"), false); // yesterday
  assert.equal(at(null).includes("NVDA"), false);
  assert.equal(upcomingEarnings(withRow("NVDA", { next_earnings: "2026-10-23" }), TODAY, 7)[0]!.when, "today");
  assert.equal(upcomingEarnings(withRow("NVDA", { next_earnings: "2026-10-24" }), TODAY, 7).find((row) => row.symbol === "NVDA")!.when, "tomorrow");
});

test("an ex-dividend date counts only from today through the call's expiry", () => {
  const items = (date: string | null) => needsYouFeed({ holdings: withRow("KO", { ex_dividend: date }), shortCalls: shortCalls(), today: TODAY }).filter((item) => item.kind === "ex_dividend");
  assert.deepEqual(items("2026-10-28").map((item) => item.title), ["KO goes ex-dividend Wed 2026-10-28", COPY.exDividendUnknown]);
  assert.equal(items("2026-10-28")[0]!.detail, "Before the $72.50 call expires Fri 2026-10-30 · early assignment is possible");
  assert.equal(items("2026-10-30").length, 2); // the expiry day itself counts
  assert.equal(items("2026-10-31").length, 1); // after the call is gone: only the unknown reminder (AAPL, JNJ)
  assert.equal(items("2026-10-22").length, 1); // already passed
  // KO's date being unknown joins the reminder.
  assert.equal(items(null)[0]!.detail, "AAPL, JNJ, KO");
});

test("the engine's own early-assignment risk is not repeated as an ex-dividend row", () => {
  const calls = shortCalls().map((call) => (call.symbol === "KO" ? { ...call, risks: [{ kind: "early_assignment_before_dividend" as const, text: "Early assignment is likely before the dividend" }] } : call));
  const feed = needsYouFeed({ holdings: withRow("KO", { ex_dividend: "2026-10-28" }), shortCalls: calls, today: TODAY });
  assert.equal(feed.some((item) => item.title.startsWith("KO goes ex-dividend")), false);
  assert.equal(feed.some((item) => item.title === "Early assignment is likely before the dividend"), true);
});

test("an import that is not connected, has none or failed leads the feed in words", () => {
  const base = holdings();
  const notConnected = needsYouFeed({ holdings: { ...base, rows: [], import: { ...base.import, state: "not_configured", statement_date: null, imported_at: null, lots: 0 } }, shortCalls: [], today: TODAY });
  assert.deepEqual(notConnected.map((item) => [item.kind, item.title, item.href]), [["import", "Holdings aren't connected yet · set up the IBKR import in Settings", "/settings"]]);
  const none = needsYouFeed({ holdings: { ...base, rows: [], import: { ...base.import, state: "none", statement_date: null, lots: 0 } }, shortCalls: null, today: TODAY });
  assert.equal(none[0]!.title, COPY.holdingsNone);
  const failed = needsYouFeed({ holdings: { ...base, import: { ...base.import, state: "failed", statement_date: "2026-10-22" } }, shortCalls: [], today: TODAY });
  assert.equal(failed[0]!.kind, "import");
  assert.equal(failed[0]!.title, "Couldn't import holdings · showing Thu 2026-10-22 · Try again");
  // A good or still-running import raises nothing.
  assert.equal(needsYouFeed({ holdings: base, shortCalls: [], today: "2026-12-01" }).some((item) => item.kind === "import"), false);
  assert.equal(needsYouFeed({ holdings: { ...base, import: { ...base.import, state: "running" } }, shortCalls: [], today: "2026-12-01" }).length, 0);
});

test("nothing loaded yields an empty feed, and the feed holds at most twenty items", () => {
  assert.deepEqual(needsYouFeed({ holdings: null, shortCalls: null, today: TODAY }), []);
  const [call] = shortCalls().filter((item) => item.symbol === "KO");
  const many = Array.from({ length: 12 }, (_, index) => ({ ...call!, id: 100 + index }));
  const feed = needsYouFeed({ holdings: holdings(), shortCalls: many, today: TODAY });
  assert.equal(feed.length, FEED_LIMIT);
  assert.equal(feed.every((item) => item.kind === "short_call_risk"), true); // the most pressing fill the cap first
});

test("no feed or tile text carries banned wording, and the feed names no dollar amount beyond a per-share strike", () => {
  const feed = needsYouFeed({ holdings: holdings(), shortCalls: shortCalls(), today: TODAY });
  const income = IncomeSchema.parse(loadFundamentalFixture("covered_calls_income"));
  const tiles = [...portfolioTiles(holdings(), false), incomeTile(income, TODAY, false), openCallsTile(shortCalls())];
  for (const text of [...feed.flatMap((item) => [item.title, item.detail]), ...tiles.flatMap((item) => [item.label, item.value, item.note ?? ""])]) {
    assert.equal(containsBannedTerm(text), false, text);
  }
});

test("portfolio tiles hide dollars while masked, keep percentages, and show dashes without holdings", () => {
  const masked = portfolioTiles(holdings(), true);
  assert.deepEqual(masked.map((item) => item.value), [MASK, `${MASK} · +0.52%`, "+27.50%"]);
  assert.equal(masked[2]!.note, MASK);
  assert.equal(masked[1]!.tone, "up");
  const shown = portfolioTiles(holdings(), false);
  assert.deepEqual(shown.map((item) => item.value), ["$483,720", "+$2,521 · +0.52%", "+27.50%"]);
  assert.equal(shown[2]!.note, "+$104,280");
  const base = holdings();
  const empty = portfolioTiles({ ...base, import: { ...base.import, state: "not_configured", statement_date: null } }, false);
  assert.deepEqual(empty.map((item) => [item.value, item.note]), [["—", null], ["—", null], ["—", null]]);
  assert.deepEqual(portfolioTiles(null, true).map((item) => item.value), ["—", "—", "—"]);
});

test("income reads month to date, says so when Trades are missing, and never shows zero for unknown", () => {
  const income = IncomeSchema.parse(loadFundamentalFixture("covered_calls_income"));
  assert.equal(incomeTile(income, TODAY, false).value, "$345");
  assert.equal(incomeTile(income, TODAY, true).value, MASK);
  assert.equal(incomeTile(income, "2026-11-02", false).value, "$0"); // a known month with no premium yet
  const needs = incomeTile({ ...income, state: "needs_trades", by_month: [], ytd_premium: null }, TODAY, false);
  assert.deepEqual([needs.value, needs.note], ["—", "Needs the Flex Trades section"]);
  assert.equal(incomeTile(null, TODAY, false).value, "—");
});

test("open calls count the positions and name the first expiry", () => {
  const tile = openCallsTile(shortCalls());
  assert.deepEqual([tile.value, tile.note], ["3", "Next expiry Fri 2026-10-30"]);
  assert.equal(openCallsTile([]).value, "None");
  assert.equal(openCallsTile(null).value, "—");
});
