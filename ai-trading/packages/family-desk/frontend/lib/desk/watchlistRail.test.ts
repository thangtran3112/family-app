import assert from "node:assert/strict";
import test from "node:test";
import { pickDefaultWatchlist } from "./watchlistRail.ts";

test("opens on her first intraday list, even when another list comes first", () => {
  const lists = [
    { id: 1, horizon: "swing" },
    { id: 2, horizon: "intraday" },
    { id: 3, horizon: "intraday" },
  ];
  assert.deepEqual(pickDefaultWatchlist(lists), { id: 2, horizon: "intraday" });
});

test("falls back to the first list when none is intraday", () => {
  const lists = [
    { id: 5, horizon: "long_term" },
    { id: 4, horizon: "swing" },
  ];
  assert.deepEqual(pickDefaultWatchlist(lists), { id: 5, horizon: "long_term" });
});

test("returns null when there are no lists", () => {
  assert.equal(pickDefaultWatchlist([]), null);
});
