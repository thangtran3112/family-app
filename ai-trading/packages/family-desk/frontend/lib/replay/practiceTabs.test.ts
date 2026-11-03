import assert from "node:assert/strict";
import test from "node:test";
import { PRACTICE_TABS, journalHref, parseThreadTab, practiceTabLabel, replayHref, screenHref, tabHref, threadPageHref } from "./practiceTabs.ts";

test("the thread page's tab comes from ?tab=: missing or unknown is Summary, so the bare URL is Summary", () => {
  assert.equal(parseThreadTab(null), "summary");
  assert.equal(parseThreadTab("portfolio"), "portfolio");
  for (const raw of ["", "summary", "Portfolio", "order", "screen", "x"]) assert.equal(parseThreadTab(raw), "summary", raw);
  assert.equal(threadPageHref(12), "/practice/thread?id=12");
  assert.equal(threadPageHref(12, "summary"), "/practice/thread?id=12");
  assert.equal(threadPageHref(12, "portfolio"), "/practice/thread?id=12&tab=portfolio");
});

test("the strip lists Summary, Portfolio, Screen, Trades (no Order tab: orders are placed on the chart)", () => {
  assert.deepEqual(PRACTICE_TABS.map((tab) => practiceTabLabel(tab)), ["Summary", "Portfolio", "Screen", "Trades"]);
});

test("every tab is a fixed URL of the thread: a freestyle thread has one Screen and one journal", () => {
  assert.equal(tabHref(7, "summary"), "/practice/thread?id=7");
  assert.equal(tabHref(7, "portfolio"), "/practice/thread?id=7&tab=portfolio");
  assert.equal(tabHref(7, "screen"), "/practice/screen?thread=7");
  assert.equal(tabHref(7, "journal"), "/practice/journal?thread=7");
  assert.equal(screenHref(7), "/practice/screen?thread=7");
  assert.equal(journalHref(7), "/practice/journal?thread=7");
  assert.equal(replayHref(31), "/practice/replay?id=31");
});
