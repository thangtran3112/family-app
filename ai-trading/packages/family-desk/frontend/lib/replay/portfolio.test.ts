import assert from "node:assert/strict";
import test from "node:test";
import { PortfolioSchema } from "./portfolio.ts";

// `GET /replay/threads/{id}/portfolio` (ADR-0025): a position is priced AT the thread clock, and a working order says how long it lives.

const account = { balance: 49_000, open_pnl_usd: 150, equity_usd: 49_150, buying_power_usd: 30_000, since_start_usd: -850, positions: 1, as_of: "2026-10-27T14:00:00Z" };

const position = {
  session_id: 12,
  symbol: "NVDA",
  side: "long",
  shares: 100,
  avg_cost: 187.5,
  price: 189,
  price_at: "2026-10-27T13:59:00Z",
  price_age_s: 60,
  unrealized_usd: 150,
  entry_at: "2026-10-23T14:02:00Z",
  held_for_s: 345_480,
  stop_price: 185,
  stop_hit_at: null,
};

const order = {
  id: 4,
  session_id: 12,
  symbol: "NVDA",
  side: "sell",
  type: "stop",
  shares: 100,
  limit_price: null,
  stop_price: 185,
  status: "working",
  placed_at: "2026-10-23T14:05:00Z",
  triggered_at: null,
  closed_at: null,
  fill_price: null,
  mark_id: null,
  reason: null,
};

test("a portfolio parses: positions priced at T, working orders, the account", () => {
  const parsed = PortfolioSchema.parse({ thread_id: 3, as_of: "2026-10-27T14:00:00Z", positions: [position], orders: [order], account, label: "SIMULATED" });
  assert.equal(parsed.positions[0]?.unrealized_usd, 150);
  assert.equal(parsed.positions[0]?.held_for_s, 345_480);
  assert.equal(parsed.account?.since_start_usd, -850);
});

test("an order without a time in force is good till cancelled and is not reduce-only", () => {
  const parsed = PortfolioSchema.parse({ thread_id: 3, as_of: null, positions: [], orders: [order], account: null, label: "SIMULATED" });
  assert.deepEqual([parsed.orders[0]?.tif, parsed.orders[0]?.expires_at, parsed.orders[0]?.reduce_only], ["gtc", null, false]);
  const day = PortfolioSchema.parse({ thread_id: 3, as_of: null, positions: [], orders: [{ ...order, tif: "day", expires_at: "2026-10-24T00:00:00Z", reduce_only: true }], account: null, label: "SIMULATED" });
  assert.deepEqual([day.orders[0]?.tif, day.orders[0]?.reduce_only], ["day", true]);
});

test("a name with no price at T is carried: price_at and price_age_s are null", () => {
  const carried = PortfolioSchema.parse({ thread_id: 3, as_of: "2026-10-27T14:00:00Z", positions: [{ ...position, price: 187.5, price_at: null, price_age_s: null, unrealized_usd: 0 }], orders: [], account, label: "SIMULATED" });
  assert.equal(carried.positions[0]?.price_at, null);
});

test("malformed portfolios are rejected", () => {
  assert.equal(PortfolioSchema.safeParse({ thread_id: 3, as_of: null, positions: [{ ...position, side: "flat" }], orders: [], account: null, label: "" }).success, false);
  assert.equal(PortfolioSchema.safeParse({ thread_id: 3, as_of: "yesterday", positions: [], orders: [], account: null, label: "" }).success, false);
  assert.equal(PortfolioSchema.safeParse({ thread_id: 3, as_of: null, positions: [], orders: [{ ...order, tif: "week" }], account: null, label: "" }).success, false);
});
