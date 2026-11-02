import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { dayLabels, fillEffect, fillRows, FillSchema, loadThreadFills, ThreadFillsSchema, type Fill } from "./fills.ts";
import { thread } from "./threadFixtures.ts";

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

test("the days are named by number, weekday and date, for the ended days and the open one", () => {
  const labels = dayLabels(thread);
  assert.equal(labels.get("2026-02-25"), "Day 3 · Wed 2026-02-25");
  assert.equal(labels.get("2026-03-10"), "Day 8 · Tue 2026-03-10", "the open day");
  assert.equal(dayLabels({ daily: [], today: null }).size, 0);
});

test("rows keep the server's order, show the ET clock and the dated day name", () => {
  const rows = fillRows([sell, fill(), fill({ id: 8, source: "auto", day: "2026-04-01", closes: 20, opens: 0 })], dayLabels(thread));
  assert.deepEqual(rows[0], { key: "10", day: "Day 3 · Wed 2026-02-25", time: "10:40:00 AM ET", symbol: "TSLA", action: "Sell", shares: "100", price: "212.25", effect: "Closed" });
  assert.deepEqual(rows[1], { key: "9", day: "Day 3 · Wed 2026-02-25", time: "10:07:00 AM ET", symbol: "TSLA", action: "Buy", shares: "100", price: "210.50", effect: "Opened or added" });
  assert.equal(rows[2]!.effect, "Closed (auto, day end)");
  assert.equal(rows[2]!.day, "—", "a day the thread does not list is a dash");
  assert.deepEqual(fillRows([], dayLabels(thread)), []);
});
