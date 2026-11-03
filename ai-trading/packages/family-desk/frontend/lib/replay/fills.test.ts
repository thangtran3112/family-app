import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { fillEffect, fillRows, FillSchema, loadThreadFills, ThreadFillsSchema, type Fill } from "./fills.ts";

const fill = (over: Partial<Fill> = {}): Fill => ({
  id: 9,
  session_id: 4,
  symbol: "TSLA",
  day: "2026-02-25",
  action: "buy",
  shares: 100,
  price: 210.5,
  at: "2026-02-25T15:07:00Z",
  closes: 0,
  opens: 100,
  trade_no: null,
  source: "her",
  ...over,
});
const sell = fill({ id: 10, action: "sell", shares: 100, price: 212.25, at: "2026-02-25T15:40:00Z", closes: 100, opens: 0, trade_no: 1 });
const out = { thread_id: 7, total: 2, fills: [sell, fill()] };

function fakeDesk(answer: unknown, status = 200) {
  const calls: string[] = [];
  const client = createDeskApiClient(
    async (input) => {
      const url = input as URL;
      calls.push(url.pathname + url.search);
      return Response.json(answer, { status });
    },
    () => ({ href: "https://trading.test/" }),
  );
  return { client, calls };
}

test("the fills answer parses, and a malformed fill is a plain error, not a half-built row", async () => {
  assert.equal(ThreadFillsSchema.parse(out).fills.length, 2);
  assert.equal(FillSchema.safeParse({ ...fill(), action: "hold" }).success, false);
  assert.equal(FillSchema.safeParse({ ...fill(), at: "10:07" }).success, false);
  assert.equal(FillSchema.safeParse({ ...fill(), source: "bot" }).success, false);
  const bad = fakeDesk({ ...out, fills: [{ ...fill(), price: null }] });
  await assert.rejects(loadThreadFills(7, { client: bad.client }), (error) => error instanceof DeskApiError && error.kind === "malformed");
});

test("the loader reads the thread's fills route and nothing else", async () => {
  const d = fakeDesk(out);
  assert.equal((await loadThreadFills(7, { client: d.client })).total, 2);
  assert.deepEqual(d.calls, ["/api/desk/replay/threads/7/fills"]);
});

test("a fill's effect comes from the shares it closed and opened", () => {
  assert.equal(fillEffect({ closes: 100, opens: 50 }), "Flipped");
  assert.equal(fillEffect({ closes: 100, opens: 0 }), "Closed");
  assert.equal(fillEffect({ closes: 0, opens: 100 }), "Opened or added");
  assert.equal(fillEffect({ closes: 0, opens: 0 }), "—");
});

test("rows keep the server's order, show the ET clock and the ET date", () => {
  const rows = fillRows([sell, fill(), fill({ id: 8, source: "auto", at: "2026-04-01T14:00:00Z", closes: 20, opens: 0 })]);
  assert.deepEqual(rows[0], { key: "10", date: "Wed 2026-02-25", time: "10:40:00 AM ET", symbol: "TSLA", action: "Sell", shares: "100", price: "212.25", effect: "Closed" });
  assert.deepEqual(rows[1], { key: "9", date: "Wed 2026-02-25", time: "10:07:00 AM ET", symbol: "TSLA", action: "Buy", shares: "100", price: "210.50", effect: "Opened or added" });
  assert.equal(rows[2]!.effect, "Closed (auto)");
  assert.equal(rows[2]!.date, "Wed 2026-04-01", "any date names itself: the thread keeps no list of days");
  assert.deepEqual(fillRows([]), []);
});

test("a fill's ET date is the date of its time, not the session's day (D-219)", () => {
  // Bought Mon 2026-08-03 at 10:29 AM ET, sold after a Next open on Tue 2026-08-04 at 9:30 AM ET: the session still reads Mon.
  const bought = fill({ id: 9, day: "2026-08-03", at: "2026-08-03T14:29:40Z" });
  const sold = fill({ id: 10, action: "sell", day: "2026-08-03", at: "2026-08-04T13:30:00Z", closes: 100, opens: 0 });
  const rows = fillRows([sold, bought]);
  assert.deepEqual([rows[0]!.date, rows[0]!.time], ["Tue 2026-08-04", "9:30:00 AM ET"]);
  assert.deepEqual([rows[1]!.date, rows[1]!.time], ["Mon 2026-08-03", "10:29:40 AM ET"]);
});
