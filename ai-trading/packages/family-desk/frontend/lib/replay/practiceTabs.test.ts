import assert from "node:assert/strict";
import test from "node:test";
import { PRACTICE_TABS, parseThreadTab, practiceTabLabel, resolveTabHref, threadPageHref, type TabLoaders } from "./practiceTabs.ts";

const loaders = (today: Awaited<ReturnType<TabLoaders["today"]>>): TabLoaders & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, today: async () => { calls.push("today"); return today; } };
};

test("the thread page's tab comes from ?tab=: missing or unknown is Summary, so the bare URL is Summary", () => {
  assert.equal(parseThreadTab(null), "summary");
  assert.equal(parseThreadTab("portfolio"), "portfolio");
  for (const raw of ["", "summary", "Portfolio", "order", "x"]) assert.equal(parseThreadTab(raw), "summary", raw);
  assert.equal(threadPageHref(12), "/practice/thread?id=12");
  assert.equal(threadPageHref(12, "summary"), "/practice/thread?id=12");
  assert.equal(threadPageHref(12, "portfolio"), "/practice/thread?id=12&tab=portfolio");
});

test("the strip lists Summary, Portfolio, Day list, Order, Trades; a swing thread's Day list is the Board", () => {
  assert.deepEqual(PRACTICE_TABS.map((tab) => practiceTabLabel(tab, "day")), ["Summary", "Portfolio", "Day list", "Order", "Trades"]);
  assert.equal(practiceTabLabel("day", "swing"), "Board");
});

test("fixed tabs never ask the server, and Order is the thread's own page: no session, no stock", async () => {
  const load = loaders({ day_list_id: 31 });
  assert.equal(await resolveTabHref(7, "summary", load), "/practice/thread?id=7");
  assert.equal(await resolveTabHref(7, "portfolio", load), "/practice/thread?id=7&tab=portfolio");
  assert.equal(await resolveTabHref(7, "journal", load), "/practice/journal?thread=7");
  assert.equal(await resolveTabHref(7, "order", load), "/practice/order?thread=7");
  assert.deepEqual(load.calls, []);
});

test("Day list follows the thread's open day; with none it lands on Summary", async () => {
  const none = loaders(null);
  assert.equal(await resolveTabHref(7, "day", none), "/practice/thread?id=7");
  assert.deepEqual(none.calls, ["today"]);
  assert.equal(await resolveTabHref(7, "day", loaders({ day_list_id: 31 })), "/practice/day?id=31");
});
