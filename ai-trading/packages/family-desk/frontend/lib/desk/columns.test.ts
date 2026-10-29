import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_PRIORITIES, columnsForBand, droppedKeys, withPriorities, type Board } from "./columns.ts";

const dashboard = ["symbol", "last", "change_pct", "rvol_10d", "vs_vwap_pct", "bias_label"].map((key) => ({ key }));
const screener = ["symbol", "last", "change_pct", "volume", "rvol_10d", "atr_pct_14", "gap_pct_open", "rsi_14", "vs_vwap_pct", "matched_since"].map((key) => ({ key }));
const watchlist = ["symbol", "last", "change_pct", "rvol_10d", "bias_label", "tags"].map((key) => ({ key }));

test("each board drops its declared columns at 1180 and keeps all at 1440", () => {
  const cases: Array<[Board, { key: string }[], string[]]> = [
    ["dashboard", dashboard, ["vs_vwap_pct", "rvol_10d"]],
    ["screener", screener, ["matched_since", "atr_pct_14", "volume"]],
    ["watchlist", watchlist, ["rvol_10d", "bias_label"]],
    // 02n §b3 "1180 column drop orders (lowest first)": no Fundamental table scrolls sideways.
    ["fundHoldings", ["symbol", "shares", "last", "change_pct", "next_earnings", "ai_rating", "open_calls", "unrealized_pct", "weight_pct"].map((key) => ({ key })), ["next_earnings", "ai_rating", "open_calls", "unrealized_pct"]],
    ["fundCandidates", ["expiry", "strike", "annualized_yield", "spread_pct", "open_interest", "return_if_called", "upside_cap", "score"].map((key) => ({ key })), ["spread_pct", "open_interest", "return_if_called", "upside_cap"]],
    ["fundShortCalls", ["symbol", "strike", "moneyness_pct", "contracts", "risks"].map((key) => ({ key })), ["moneyness_pct", "contracts"]],
    ["fundBrief", ["symbol", "rating", "eps_rev_30d_pct", "confidence", "upside_pct"].map((key) => ({ key })), ["eps_rev_30d_pct", "confidence"]],
  ];
  for (const [board, columns, dropped] of cases) {
    const prioritized = withPriorities(columns, board);
    assert.deepEqual(droppedKeys(prioritized), dropped, `${board} drop order`);
    assert.equal(columnsForBand(prioritized, "1440").length, columns.length);
    const kept = columnsForBand(prioritized, "1180").map((column) => column.key);
    assert.deepEqual(kept, columns.map((column) => column.key).filter((key) => !dropped.includes(key)));
    for (const key of dropped) assert.equal(kept.includes(key), false);
  }
});

test("the symbol, last and change columns are never dropped", () => {
  for (const board of Object.keys(BOARD_PRIORITIES) as Board[]) {
    for (const key of ["symbol", "last", "change_pct"]) assert.equal(key in BOARD_PRIORITIES[board], false);
  }
});

test("columns the board does not prioritise stay untouched", () => {
  const [column] = withPriorities([{ key: "extra" }], "dashboard");
  assert.deepEqual(column, { key: "extra" });
});
