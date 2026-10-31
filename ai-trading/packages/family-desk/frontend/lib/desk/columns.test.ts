import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_PRIORITIES, columnFromSpec, columnsForBand, droppedKeys, withPriorities, type Board, type ColumnSpec } from "./columns.ts";

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
    // The swing board (02p d1) registers here instead of keeping its own DROPPED_AT_1180 table.
    ["boardView", ["star", "symbol", "prior_close", "chg_5d_pct", "avg_dollar_volume_20d", "vs_50d_avg_pct", "rsi_14", "matches", "earnings"].map((key) => ({ key })), ["avg_dollar_volume_20d", "vs_50d_avg_pct", "chg_5d_pct", "rsi_14"]],
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

type Row = { chg: number | null; label: string };
const spec = (overrides: Partial<ColumnSpec> = {}): ColumnSpec => ({ key: "chg", label: "Chg", format: "pct_signed", ...overrides });

test("columnFromSpec renders through formatMetric and sorts by the raw value", () => {
  const column = columnFromSpec<Row>(spec(), (row) => row.chg);
  assert.deepEqual([column.key, column.label, column.kind, column.align], ["chg", "Chg", "num", "right"]);
  assert.equal(column.render({ chg: 1.234, label: "" }), "+1.23%");
  assert.equal(column.render({ chg: null, label: "" }), "—");
  assert.equal(column.sortValue({ chg: 1.234, label: "" }), 1.234);
  assert.equal(column.sortValue({ chg: null, label: "" }), null);
  assert.equal("priority" in column, false, "no priority in the spec, none on the column");
  assert.equal("firstSort" in column, false, "the table's own number-first-descending default stands");
});

test("columnFromSpec keeps text left, honours align, priority and firstSort, and paints the sign with changeTone", () => {
  const time = columnFromSpec<Row>(spec({ key: "t", label: "Since", format: "time", priority: 2, firstSort: "asc" }), () => "2026-10-23T14:00:00Z");
  assert.deepEqual([time.kind, time.align, time.priority, time.firstSort], ["text", "left", 2, "asc"]);
  assert.equal(columnFromSpec<Row>(spec({ format: "text", align: "right" }), (row) => row.label).align, "right", "an explicit align wins");
  const paint = (text: string, tone: string) => `${tone}:${text}`;
  const signed = columnFromSpec<Row>(spec(), (row) => row.chg, paint);
  assert.equal(signed.render({ chg: 2, label: "" }), "up:+2.00%");
  assert.equal(signed.render({ chg: -2, label: "" }), "down:−2.00%");
  assert.equal(signed.render({ chg: null, label: "" }), "flat:—");
  const plain = columnFromSpec<Row>(spec({ format: "price" }), (row) => row.chg, paint);
  assert.equal(plain.render({ chg: 2, label: "" }), "2.00", "only pct_signed carries a tone");
});

test("a spec's priority registers with withPriorities like any board column", () => {
  const columns = [spec({ key: "rvol_10d" }), spec({ key: "last" })].map((item) => columnFromSpec<Row>(item, (row) => row.chg));
  assert.deepEqual(droppedKeys(withPriorities(columns, "watchlist")), ["rvol_10d"]);
});
