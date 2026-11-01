import assert from "node:assert/strict";
import test from "node:test";
import { PRACTICE_TABS, parseThreadTab, practiceTabLabel, resolveTabHref, threadPageHref, type TabLoaders } from "./practiceTabs.ts";

const loaders = (today: Awaited<ReturnType<TabLoaders["today"]>>, sessions: number[] = []): TabLoaders & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    today: async () => { calls.push("today"); return today; },
    sessions: async () => { calls.push("sessions"); return sessions; },
  };
};

test("the thread page's tab comes from ?tab=: missing or unknown is Summary, so the bare URL is Summary", () => {
  assert.equal(parseThreadTab(null), "summary");
  assert.equal(parseThreadTab("portfolio"), "portfolio");
  for (const raw of ["", "summary", "Portfolio", "trade", "x"]) assert.equal(parseThreadTab(raw), "summary", raw);
  assert.equal(threadPageHref(12), "/practice/thread?id=12");
  assert.equal(threadPageHref(12, "summary"), "/practice/thread?id=12");
  assert.equal(threadPageHref(12, "portfolio"), "/practice/thread?id=12&tab=portfolio");
});

test("the strip lists Summary, Portfolio, Day list, Trade, Journal; a swing thread's Day list is the Board", () => {
  assert.deepEqual(PRACTICE_TABS.map((tab) => practiceTabLabel(tab, "day")), ["Summary", "Portfolio", "Day list", "Trade", "Journal"]);
  assert.equal(practiceTabLabel("day", "swing"), "Board");
});

test("fixed tabs never ask the server", async () => {
  const load = loaders(null);
  assert.equal(await resolveTabHref(7, "summary", load), "/practice/thread?id=7");
  assert.equal(await resolveTabHref(7, "portfolio", load), "/practice/thread?id=7&tab=portfolio");
  assert.equal(await resolveTabHref(7, "journal", load), "/practice/journal?thread=7");
  assert.deepEqual(load.calls, []);
});

test("Day list and Trade follow the thread's open day; with none they land on Summary", async () => {
  const none = loaders(null);
  assert.equal(await resolveTabHref(7, "day", none), "/practice/thread?id=7");
  assert.equal(await resolveTabHref(7, "trade", none), "/practice/thread?id=7");
  assert.deepEqual(none.calls, ["today", "today"]);
});

test("Trade opens the open day's latest session; a listed day or a day with no session lands on the day list", async () => {
  assert.equal(await resolveTabHref(7, "day", loaders({ day_list_id: 31, status: "practicing" }, [4, 9])), "/practice/day?id=31");
  assert.equal(await resolveTabHref(7, "trade", loaders({ day_list_id: 31, status: "practicing" }, [4, 9])), "/practice/replay?id=9");
  const listed = loaders({ day_list_id: 31, status: "listed" });
  assert.equal(await resolveTabHref(7, "trade", listed), "/practice/day?id=31");
  assert.deepEqual(listed.calls, ["today"], "a listed day has no session to look up");
  assert.equal(await resolveTabHref(7, "trade", loaders({ day_list_id: 31, status: "practicing" }, [])), "/practice/day?id=31");
});
