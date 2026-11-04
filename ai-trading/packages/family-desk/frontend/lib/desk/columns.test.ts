import assert from "node:assert/strict";
import test from "node:test";
import { BOARD_PRIORITIES, SCREEN_WIDTH_CAPS, columnFromSpec, droppedKeys, withPriorities, type Board, type ColumnSpec } from "./columns.ts";
import { fitColumns, type ColumnWidth } from "./denseTable.ts";

const dashboard = ["symbol", "last", "change_pct", "rvol_10d", "vs_vwap_pct", "bias_label"].map((key) => ({ key }));
const screener = ["symbol", "last", "change_pct", "volume", "rvol_10d", "atr_pct_14", "gap_pct_open", "rsi_14", "vs_vwap_pct", "matched_since"].map((key) => ({ key }));
const watchlist = ["symbol", "last", "change_pct", "rvol_10d", "bias_label", "tags"].map((key) => ({ key }));

test("each board declares which columns may drop and in what order (lowest first)", () => {
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
    // The Trades fills table (D-157): the effect goes first, then the day.
    ["threadFills", ["day", "time", "symbol", "action", "shares", "price", "effect"].map((key) => ({ key })), ["effect", "day"]],
    // The day list (D-157): the match time, the filter names, volume, gap and vs VWAP, then prev close drop; price, prev RVOL, prev change, ATR % and RSI never do.
    ["practiceList", ["symbol", "filters", "list_price", "price_now", "change_now", "prev_close", "prev_rvol", "prev_change_pct", "atr_pct_14", "rsi_14", "earnings", "volume", "gap_pct_open", "vs_vwap_pct", "matched_since", "high_252d", "dist_to_252d_high_pct"].map((key) => ({ key })), ["matched_since", "volume", "gap_pct_open", "vs_vwap_pct", "prev_close", "high_252d", "dist_to_252d_high_pct"]],
    // The Screen for a scan read after the open (D-243), following the clock, with a filter that reads the 52-week high: the previous close and the fixed block's tail drop first,
    // then the scan's change % (what "vs prev close % now" says), the previous session's change and RVOL, then the filter's own 52-week numbers. The name, the scan price, the price now
    // and its move, RVOL now, ATR %, RSI and earnings never do.
    ["practiceListOpen", ["symbol", "filters", "list_price", "price_now", "change_now", "prev_close", "prev_rvol", "prev_change_pct", "atr_pct_14", "rsi_14", "earnings", "change_pct", "volume", "rvol_10d", "gap_pct_open", "vs_vwap_pct", "high_252d", "dist_to_252d_high_pct", "matched_since"].map((key) => ({ key })), ["matched_since", "volume", "gap_pct_open", "vs_vwap_pct", "prev_close", "change_pct", "prev_change_pct", "prev_rvol", "high_252d", "dist_to_252d_high_pct"]],
  ];
  for (const [board, columns, dropped] of cases) {
    const prioritized = withPriorities(columns, board);
    assert.deepEqual(droppedKeys(prioritized), dropped, `${board} drop order`);
    assert.equal(prioritized.length, columns.length, "declaring a priority never removes a column");
    const never = prioritized.filter((column) => column.priority === undefined).map((column) => column.key);
    assert.deepEqual(never, columns.map((column) => column.key).filter((key) => !dropped.includes(key)), `${board} keeps the rest`);
  }
});

test("the symbol, last and change columns are never dropped", () => {
  for (const board of Object.keys(BOARD_PRIORITIES) as Board[]) {
    for (const key of ["symbol", "last", "change_pct"]) {
      // The Screen's move is "vs prev close %" / "vs prev close % now", which never drops; its `change_pct` is the scan's repeat of that figure (D-243).
      if (board === "practiceListOpen" && key === "change_pct") continue;
      assert.equal(key in BOARD_PRIORITIES[board], false, `${board} ${key}`);
    }
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

test("columnFromSpec keeps text left, honours align, priority and firstSort, and paints the sign with signTone", () => {
  const time = columnFromSpec<Row>(spec({ key: "t", label: "Since", format: "time", priority: 2, firstSort: "asc" }), () => "2026-10-23T14:00:00Z");
  assert.deepEqual([time.kind, time.align, time.priority, time.firstSort], ["text", "left", 2, "asc"]);
  assert.equal(columnFromSpec<Row>(spec({ format: "text", align: "right" }), (row) => row.label).align, "right", "an explicit align wins");
  const paint = (text: string, tone: string) => `${tone}:${text}`;
  const signed = columnFromSpec<Row>(spec(), (row) => row.chg, paint);
  assert.equal(signed.render({ chg: 2, label: "" }), "up:+2.00%");
  assert.equal(signed.render({ chg: -2, label: "" }), "down:−2.00%");
  assert.equal(signed.render({ chg: null, label: "" }), "neutral:—");
  const plain = columnFromSpec<Row>(spec({ format: "price" }), (row) => row.chg, paint);
  assert.equal(plain.render({ chg: 2, label: "" }), "2.00", "only pct_signed carries a tone");
});

test("a spec's priority registers with withPriorities like any board column", () => {
  const columns = [spec({ key: "rvol_10d" }), spec({ key: "last" })].map((item) => columnFromSpec<Row>(item, (row) => row.chg));
  assert.deepEqual(droppedKeys(withPriorities(columns, "watchlist")), ["rvol_10d"]);
});

// -- the Screen after the open at 1440 and 1180 (D-243 residual) -----------------------------------------------------------------
// Widths measured on the live Screen (wave 31, 30 rows, scan after the open), headers wrapped, in px: the name's cell is the ticker and its "No longer matches" badge, the filters the longest joined names.
// The Earnings cell is 98 px when no name reported and 187 px with the "Reported before the open" badge. The pinned actions cell is 185 px. Panes: 1088 px at 1440 (the right rail is open), 1108 px at 1180, 1228 px at 1300.
const ACTIONS = { max: 185, min: 185 };
const NEVER = { symbol: 182, filters: 214, list_price: 72, price_now: 71, change_now: 82, atr_pct_14: 74, rsi_14: 62, earnings: 98, rvol_10d: 68 };
const DROPPABLE = { matched_since: 90, volume: 70, gap_pct_open: 62, vs_vwap_pct: 70, prev_close: 75, change_pct: 78, prev_change_pct: 88, prev_rvol: 68 };
const ORDER = ["symbol", "filters", "list_price", "price_now", "change_now", "prev_close", "prev_rvol", "prev_change_pct", "atr_pct_14", "rsi_14", "earnings", "change_pct", "volume", "rvol_10d", "gap_pct_open", "vs_vwap_pct", "matched_since"];

/** The columns as DenseTable measures them: the cap applies to the cells that carry one. */
function screenWidths(natural: Record<string, number>, capped: boolean): ColumnWidth[] {
  const all: Record<string, number> = { ...natural };
  const prioritized = withPriorities(ORDER.map((key) => ({ key })), "practiceListOpen");
  return prioritized.map((column) => {
    const cap = capped && column.key in SCREEN_WIDTH_CAPS ? SCREEN_WIDTH_CAPS[column.key as keyof typeof SCREEN_WIDTH_CAPS] : Infinity;
    const width = Math.min(all[column.key] ?? 0, cap);
    return { key: column.key, ...(column.priority === undefined ? {} : { priority: column.priority }), max: width, min: width };
  });
}
const neverKeys = Object.keys(NEVER);
const live = { ...NEVER, ...DROPPABLE };

test("D-243: the live post-open Screen's never-drop set is wider than the 1440 pane when nothing is capped", () => {
  const fit = fitColumns(screenWidths(live, false), ACTIONS, 1088);
  assert.equal(neverKeys.reduce((sum, key) => sum + NEVER[key as keyof typeof NEVER], ACTIONS.max), 1108, "1,108 px of never-drop columns beside the actions (1,107 as measured, to the pixel)");
  assert.equal(fit.fits, false, "the table overflows its pane: this is the defect");
});

test("D-243: capped, the never-drop set of the live Screen holds the 1440, 1300 and 1180 panes and drops only what may drop", () => {
  for (const pane of [1088, 1108, 1228]) {
    const fit = fitColumns(screenWidths(live, true), ACTIONS, pane);
    assert.equal(fit.fits, true, `${pane} px pane`);
    assert.deepEqual(fit.hidden.filter((key) => neverKeys.includes(key)), [], `${pane} px: nothing that never drops is hidden`);
  }
  // 1180 keeps the drop order of the board: the previous session's change goes before its RVOL.
  assert.deepEqual(fitColumns(screenWidths(live, true), ACTIONS, 1108).hidden, ["matched_since", "volume", "gap_pct_open", "vs_vwap_pct", "prev_close", "change_pct", "prev_change_pct"]);
});

test("D-243: the worst Screen (a name that reported, the longest filters, a rescan badge in the name) still holds the 1440 pane with room to spare", () => {
  const worst = { ...live, earnings: 187 };
  const fit = fitColumns(screenWidths(worst, true), ACTIONS, 1088);
  assert.equal(fit.fits, true);
  assert.deepEqual(fit.hidden.filter((key) => neverKeys.includes(key)), []);
  const need = screenWidths(worst, true).filter((column) => column.priority === undefined).reduce((sum, column) => sum + column.max, ACTIONS.max);
  assert.ok(need <= 1088 - 12, `${need} px leaves less than 12 px of margin in the 1,088 px pane`);
});

test("D-243: a cap never makes a short name wider, so a table that fitted still fits", () => {
  const short = { ...live, symbol: 87, filters: 162 };
  assert.deepEqual(screenWidths(short, true).map((column) => column.max), screenWidths(short, false).map((column) => column.max));
});
