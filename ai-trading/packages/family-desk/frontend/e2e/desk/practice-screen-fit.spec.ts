import { origin } from "../helpers";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { createThreadByApi, saveFilter } from "./hub-helpers";
import { EVERY_NAME, openScreen } from "./lane-helpers";

// D-243: a 30-row Screen with every column a scan can carry (18 of them after the open) holds its pane at 1440 and at 1180. The stub universe has four
// names, so the answer is rewritten: the server's columns, thirty names with a live block, and an earnings badge on some. Which columns may drop is
// `BOARD_PRIORITIES.practiceListOpen` (lib/desk/columns.ts); the rest must be on screen whole, with the pinned actions beside them and no sideways scroll.

const SERVER_COLUMNS = [
  { key: "list_price", label: "List price", format: "price" },
  { key: "list_change_pct", label: "vs prev close %", format: "pct_signed" },
  { key: "change_pct", label: "Change %", format: "pct_signed" },
  { key: "volume", label: "Volume", format: "compact" },
  { key: "rvol_10d", label: "RVOL", format: "ratio" },
  { key: "atr_pct_14", label: "ATR %", format: "pct" },
  { key: "gap_pct_open", label: "Gap %", format: "pct_signed" },
  { key: "rsi_14", label: "RSI", format: "number" },
  { key: "vs_vwap_pct", label: "vs VWAP %", format: "pct_signed" },
  { key: "high_252d", label: "52-week high", format: "price" },
  { key: "dist_to_252d_high_pct", label: "vs 52-week high %", format: "pct_signed" },
  { key: "matched_since", label: "Since", format: "time" },
];

const SYMBOLS = "SMCI ANET NVDA TSLA AMD PLTR COIN MSTR HOOD RIVN SOFI UPST AFRM CVNA DKNG RBLX SNAP PINS ROKU TTD NET CRWD ZS DDOG MDB SHOP SQ PYPL ABNB UBER".split(" ");
// The widest Filters cell is what the pane has to hold beside everything that never drops: 186 px here, 162 px on the live walks (D-223).
const FILTERS = [["High volatility", "Gap up"], ["Gap up", "Abnormal volume"], ["Abnormal volume"]];


function candidate(symbol: string, index: number, live: boolean) {
  const price = 40 + index * 13.37;
  const metrics = {
    list_price: price, list_change_pct: 8.4 + index / 10, last: price, change_pct: 12.4 + index / 7, volume: 1_800_000 + index * 91_000, rvol_10d: 2.5 + index / 9, atr_pct_14: 4.1 + index / 20,
    gap_pct_open: 7.9 + index / 8, rsi_14: 61 + index / 3, vs_vwap_pct: 1.4 + index / 40, high_252d: price * 1.3, dist_to_252d_high_pct: -3.2 - index / 10,
  };
  return {
    rank: index + 1, symbol, filters: FILTERS[index % 3], rank_value: null, matched_since: "2026-09-25T13:25:00Z", operands: {}, list_price: price, price_at: "2026-09-25T13:30:00Z", prior_close: price / 1.08,
    prev_rvol: 1.1 + index / 30, prev_change_pct: 1.2 + index / 50, earnings_state: index % 4 === 0 ? "reported" : index % 4 === 1 ? "none" : null, metrics, new_since_list: false, held_over: false,
    live: live ? { at: "2026-09-25T13:45:00Z", price: price * 1.02, change_pct: 17.41 + index / 5, today: true, metrics: { ...metrics, volume: 2_900_000 + index * 91_000, rvol_10d: 3.2 + index / 9 } } : null,
  };
}

/** The two scans that carry the scan's own RVOL and change % beside the previous session's: after the open, following the clock, and a closed thread (no "now" columns). A scan read before
 * the open has only the previous session's figures; its table is the existing stub specs' (`practice.spec.ts`). */
const SCANS = [
  { name: "after the open", prevBasis: false, live: true, closed: false, keep: ["Symbol", "Filters", "Price at scan", "Price now", "vs prev close % now", "ATR %", "RSI", "Earnings", "RVOL now"] },
  { name: "a closed thread", prevBasis: false, live: false, closed: true, keep: ["Symbol", "Filters", "List price", "vs prev close %", "ATR %", "RSI", "Earnings", "RVOL"] },
] as const;

for (const scan of SCANS) {
  test(`D-243 the 30-row Screen ${scan.name} holds its pane: no column is under the pinned actions`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await prepareDesk(context);
    await saveFilter(context, EVERY_NAME);
    const threadId = await createThreadByApi(context, { startAt: "2026-09-25T09:45:00-04:00" });
    await openScreen(page, context, threadId);
    await page.route(`${origin}/api/desk/replay/threads/${threadId}/screen*`, async (route) => {
      if (route.request().method() !== "GET" || route.request().url().includes("peek=")) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.columns = SERVER_COLUMNS;
      body.universe = { ...body.universe, prev_basis: scan.prevBasis };
      body.candidates = SYMBOLS.map((symbol, index) => candidate(symbol, index, scan.live));
      if (scan.closed && body.thread) body.thread = { ...body.thread, status: "closed" };
      await route.fulfill({ response, json: body });
    });
    await openDesk(page, `/practice/screen?thread=${threadId}`);
    const table = page.getByRole("table", { name: "Candidates" });
    await expect(table.getByRole("row")).toHaveCount(31, { timeout: 60_000 });

    // The columns the table settled on (D-159 keeps them from the first paint; the pane fit is applied before it): the ones that never drop are all here.
    const pane = async () => table.evaluate((element) => {
      const wrap = element.parentElement!;
      const shown = [...element.querySelectorAll("thead th:not([data-dropped])")].map((th) => th.textContent?.replace(/[▲▼]/g, "").trim() ?? "");
      const widths = [...element.querySelectorAll("thead th:not([data-dropped])")].map((th) => Math.round(th.getBoundingClientRect().width));
      return { width: wrap.clientWidth, content: wrap.scrollWidth, shown, widths };
    });
    // The fit is applied in the frame after the rows land: wait for the table to hold its pane, and let the check below name the overflow if it never does.
    await expect.poll(async () => { const now = await pane(); return now.content <= now.width; }, { timeout: 5_000 }).toBe(true).catch(() => undefined);
    const settled = await pane();
    expect(settled.content, `the table is ${settled.content - settled.width} px wider than its ${settled.width} px pane: ${settled.shown.map((label, index) => `${label} ${settled.widths[index]}`).join(", ")}`).toBeLessThanOrEqual(settled.width);
    for (const label of scan.keep) expect(settled.shown, `${label} stays`).toContain(label);
    // The first cell of the last kept column ends before the pinned actions begin.
    const clear = await table.evaluate((element) => {
      const actions = element.querySelector("tbody tr:first-child td:last-child")!.getBoundingClientRect().left;
      const last = [...element.querySelectorAll("tbody tr:first-child td:not([data-dropped])")].at(-2)!.getBoundingClientRect().right;
      return { actions, last };
    });
    expect(clear.last, "the last column runs under the pinned actions").toBeLessThanOrEqual(clear.actions + 1);

    // A resize round trip keeps it (the pane is the table's own box, not the window).
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width + 120, height: size.height });
    await page.setViewportSize(size);
    await expect.poll(async () => { const now = await pane(); return now.content <= now.width && scan.keep.every((label) => now.shown.includes(label)); }).toBe(true);
  });
}
