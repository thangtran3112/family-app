import { origin } from "../helpers";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { createThreadByApi, saveFilter } from "./hub-helpers";
import { EVERY_NAME, openScreen } from "./lane-helpers";

// D-243: a 30-row Screen with every column a scan can carry (18 of them after the open) holds its pane at 1440 and at 1180. The stub universe has four
// names, so the answer is rewritten: the server's columns, thirty names with a live block, and an earnings badge on some. Which columns may drop is
// `BOARD_PRIORITIES.practiceListOpen` (lib/desk/columns.ts); the rest must be on screen whole, with the pinned actions beside them and no sideways scroll.
// The residual (wave 31): a live scan's name cell carries a rescan badge and its filters are longer than the stub's, so the never-drop set was 1,107 px in the
// 1,088 px pane at 1440 and the last column ran 19 px under the actions. The name, the filters and the earnings cell are capped (`SCREEN_WIDTH_CAPS`), so the
// set holds whatever the scan carries: the three shapes below are the stub's, a live scan's, and the widest all at once.

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

/** A scan whose filters do not read the 52-week high carries neither of its two columns (the wave 31 scan): the room goes to the previous session's figures instead. */
const WITHOUT_52_WEEK = SERVER_COLUMNS.filter((column) => !column.key.includes("252d"));

const SYMBOLS = "SMCI ANET NVDA TSLA AMD PLTR COIN MSTR HOOD RIVN SOFI UPST AFRM CVNA DKNG RBLX SNAP PINS ROKU TTD NET CRWD ZS DDOG MDB SHOP SQ PYPL ABNB UBER".split(" ");
// The widest Filters cell is what the pane has to hold beside everything that never drops: 186 px here, 162 px on the live walks (D-223).
const FILTERS = [["High volatility", "Gap up"], ["Gap up", "Abnormal volume"], ["Abnormal volume"]];

/** What a scan's rows carry that the stub's do not: a rescan badge beside the ticker, longer filter names, and (or not) a name that reported. */
type Shape = { filters: string[][]; badges: boolean; reported: boolean };
const STUB: Shape = { filters: FILTERS, badges: false, reported: true };
/** Wave 31: the name's cell 182 px wide (ticker and its "No longer matches" badge), the filters 214, the earnings cell 98 (no name reported). */
const LIVE: Shape = { filters: [["Strong gap", "Abnormal volume"], ["Gap up", "Abnormal volume"], ["Abnormal volume"]], badges: true, reported: false };
/** Every cell at its widest at once: a badge, three filters, and a name that reported before the open. */
const WIDEST: Shape = { filters: [["High volatility", "Gap up", "Abnormal volume"], ["Gap up", "Abnormal volume"], ["Abnormal volume"]], badges: true, reported: true };

function candidate(symbol: string, index: number, live: boolean, shape: Shape) {
  const price = 40 + index * 13.37;
  const metrics = {
    list_price: price, list_change_pct: 8.4 + index / 10, last: price, change_pct: 12.4 + index / 7, volume: 1_800_000 + index * 91_000, rvol_10d: 2.5 + index / 9, atr_pct_14: 4.1 + index / 20,
    gap_pct_open: 7.9 + index / 8, rsi_14: 61 + index / 3, vs_vwap_pct: 1.4 + index / 40, high_252d: price * 1.3, dist_to_252d_high_pct: -3.2 - index / 10,
  };
  return {
    rank: index + 1, symbol, filters: shape.filters[index % 3], rank_value: null, matched_since: "2026-09-25T13:25:00Z", operands: {}, list_price: price, price_at: "2026-09-25T13:30:00Z", prior_close: price / 1.08,
    prev_rvol: 1.1 + index / 30, prev_change_pct: 1.2 + index / 50, earnings_state: shape.reported ? (index % 4 === 0 ? "reported" : index % 4 === 1 ? "none" : null) : index % 2 === 0 ? "none" : null, metrics,
    new_since_list: shape.badges && index % 5 === 0, held_over: shape.badges && index % 5 === 1,
    live: live ? { at: "2026-09-25T13:45:00Z", price: price * 1.02, change_pct: 17.41 + index / 5, today: true, metrics: { ...metrics, volume: 2_900_000 + index * 91_000, rvol_10d: 3.2 + index / 9 } } : null,
  };
}

/** The two scans that carry the scan's own RVOL and change % beside the previous session's: after the open, following the clock, and a closed thread (no "now" columns). A scan read before
 * the open has only the previous session's figures; its table is the existing stub specs' (`practice.spec.ts`). */
const OPEN_KEEP = ["Symbol", "Filters", "Price at scan", "Price now", "vs prev close % now", "ATR %", "RSI", "Earnings", "RVOL now"];
/** `width`: a viewport of its own (the table's pane at 1300 is 1,228 px, where the previous session's RVOL and change come back); without it, the project's 1440 or 1180. `columns`: the server's. */
const SCANS = [
  { name: "after the open", shape: STUB, columns: SERVER_COLUMNS, prevBasis: false, live: true, closed: false, width: null, keep: OPEN_KEEP },
  { name: "after the open, a live rescan (a badge beside the ticker, longer filters)", shape: LIVE, columns: SERVER_COLUMNS, prevBasis: false, live: true, closed: false, width: null, keep: OPEN_KEEP },
  { name: "after the open, the widest cells at once", shape: WIDEST, columns: SERVER_COLUMNS, prevBasis: false, live: true, closed: false, width: null, keep: OPEN_KEEP },
  { name: "after the open at 1300, a live rescan", shape: LIVE, columns: WITHOUT_52_WEEK, prevBasis: false, live: true, closed: false, width: 1300, keep: [...OPEN_KEEP, "Prev RVOL", "Prev change %"] },
  { name: "after the open at 1300, the widest cells at once", shape: WIDEST, columns: SERVER_COLUMNS, prevBasis: false, live: true, closed: false, width: 1300, keep: OPEN_KEEP },
  { name: "a closed thread", shape: STUB, columns: SERVER_COLUMNS, prevBasis: false, live: false, closed: true, width: null, keep: ["Symbol", "Filters", "List price", "vs prev close %", "ATR %", "RSI", "Earnings", "RVOL"] },
] as const;

for (const scan of SCANS) {
  test(`D-243 the 30-row Screen ${scan.name} holds its pane: no column is under the pinned actions`, async ({ page, context }) => {
    test.setTimeout(120_000);
    // A 1300 px viewport is the same for both projects: run it once.
    test.skip(scan.width !== null && test.info().project.name !== "desktop-1440", "a viewport of its own: one project runs it");
    if (scan.width !== null) await page.setViewportSize({ width: scan.width, height: page.viewportSize()!.height });
    await prepareDesk(context);
    await saveFilter(context, EVERY_NAME);
    const threadId = await createThreadByApi(context, { startAt: "2026-09-25T09:45:00-04:00" });
    await openScreen(page, context, threadId);
    await page.route(`${origin}/api/desk/replay/threads/${threadId}/screen*`, async (route) => {
      if (route.request().method() !== "GET" || route.request().url().includes("peek=")) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.columns = scan.columns;
      body.universe = { ...body.universe, prev_basis: scan.prevBasis };
      body.candidates = SYMBOLS.map((symbol, index) => candidate(symbol, index, scan.live, scan.shape));
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
    // clientWidth === scrollWidth: no sideways scroll (a scroller's scrollWidth is never below its clientWidth).
    expect(settled.content, `the table is ${settled.content - settled.width} px wider than its ${settled.width} px pane: ${settled.shown.map((label, index) => `${label} ${settled.widths[index]}`).join(", ")}`).toBe(settled.width);
    for (const label of scan.keep) expect(settled.shown, `${label} stays`).toContain(label);
    // The last kept column of every row ends before the pinned actions begin: no cell box sits under them.
    const clear = await table.evaluate((element) => {
      const actions = element.querySelector("tbody tr:first-child td:last-child")!.getBoundingClientRect().left;
      const last = Math.max(...[...element.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td:not([data-dropped])")].at(-2)!.getBoundingClientRect().right));
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

// D-247: the Symbol cell is capped at 112 px, so a rescan pill beside the ticker was eaten whole by the cell's ellipsis and a row that is "New in this scan" or "No longer matches" showed
// nothing. The state is now a dot (`data-rescan`) that the ellipsis cannot take: the ticker truncates, the dot is fixed. It shows at every width the Screen runs at, with the ticker whole.
const MARK_WIDTHS = [null, 1300] as const;
for (const width of MARK_WIDTHS) {
  test(`D-247 a new or kept row shows its state beside a whole ticker${width === null ? "" : ` at ${width}`}`, async ({ page, context }) => {
    test.setTimeout(120_000);
    test.skip(width !== null && test.info().project.name !== "desktop-1440", "a viewport of its own: one project runs it");
    if (width !== null) await page.setViewportSize({ width, height: page.viewportSize()!.height });
    await prepareDesk(context);
    await saveFilter(context, EVERY_NAME);
    const threadId = await createThreadByApi(context, { startAt: "2026-09-25T09:45:00-04:00" });
    await openScreen(page, context, threadId);
    // Row 0 is new in this scan (a 4-letter ticker), row 1 is kept though it no longer matches (5 letters, the widest the cap must show whole), row 5 is new with a ticker too long for the cell.
    const names = new Map([[0, "SMCI"], [1, "GOOGL"], [5, "VERYLONGTICKER"]]);
    await page.route(`${origin}/api/desk/replay/threads/${threadId}/screen*`, async (route) => {
      if (route.request().method() !== "GET" || route.request().url().includes("peek=")) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.columns = SERVER_COLUMNS;
      body.universe = { ...body.universe, prev_basis: false };
      body.candidates = SYMBOLS.map((symbol, index) => candidate(names.get(index) ?? symbol, index, true, LIVE));
      await route.fulfill({ response, json: body });
    });
    await openDesk(page, `/practice/screen?thread=${threadId}`);
    const table = page.getByRole("table", { name: "Candidates" });
    await expect(table.getByRole("row")).toHaveCount(31, { timeout: 60_000 });

    const cell = async (symbol: string) => {
      const td = table.locator("tbody tr", { hasText: symbol }).first().locator("td").first();
      return td.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const mark = element.querySelector("[data-rescan]");
        const dot = mark?.getBoundingClientRect();
        const name = mark?.parentElement?.firstElementChild as HTMLElement | null;
        return {
          text: (element as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          textContent: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
          state: mark?.getAttribute("data-rescan") ?? null,
          label: mark?.getAttribute("aria-label") ?? null,
          title: mark?.getAttribute("title") ?? null,
          dot: dot ? { width: dot.width, height: dot.height, inside: dot.left >= box.left && dot.right <= box.right && dot.top >= box.top && dot.bottom <= box.bottom } : null,
          whole: name ? name.scrollWidth <= name.clientWidth : null,
          cell: Math.round(box.width),
        };
      });
    };

    const fresh = await cell("SMCI");
    expect(fresh.state, "a new row has its marker").toBe("new");
    expect(fresh.label).toBe("New in this scan");
    expect(fresh.title).toBe("New in this scan");
    expect(fresh.textContent).toBe("SMCI · New in this scan");
    expect(fresh.whole, "the 4-letter ticker is whole").toBe(true);

    const kept = await cell("GOOGL");
    expect(kept.state, "a kept row has its marker").toBe("held");
    expect(kept.label).toBe("No longer matches");
    expect(kept.title).toBe("No longer matches");
    expect(kept.textContent).toBe("GOOGL · No longer matches");
    expect(kept.whole, "the 5-letter ticker is whole in the 112 px cell").toBe(true);

    const long = await cell("VERYLONGTICKER");
    expect(long.state, "a ticker too long for the cell still shows the marker").toBe("new");
    expect(long.whole, "that ticker truncates, the marker does not").toBe(false);

    for (const mark of [fresh, kept, long]) {
      expect(mark.dot!.width, "the marker has a box").toBeGreaterThan(0);
      expect(mark.dot!.height).toBeGreaterThan(0);
      expect(mark.dot!.inside, "the marker is inside its cell").toBe(true);
    }
    // A plain row carries no marker.
    await expect(table.locator("tbody tr", { hasText: "NVDA" }).first().locator("[data-rescan]")).toHaveCount(0);
  });
}
