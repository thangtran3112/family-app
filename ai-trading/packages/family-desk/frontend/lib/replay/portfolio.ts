import { z } from "zod";
import type { components } from "../api/openapi.js";
import { ClockAccountSchema } from "./threadClock.ts";

// `GET /replay/threads/{id}/portfolio` (ADR-0025): every open position across the thread's lanes priced AT the thread clock `T`, the working
// orders, and the account. One price function serves the header, the forming candle and this table, so they agree. A position persists
// through the close, the night, the weekend and a Jump: it changes only when she trades it, an order of hers fills, or a split restates it.
// Every dollar is SIMULATED.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });

export const PortfolioPositionSchema = z.object({
  session_id: finite.int(),
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  shares: finite.int(),
  avg_cost: finite,
  /** The price at `T`: the last print at or before it (the previous session's, before the day's first bar). */
  price: finite,
  /** When that print happened, and how old it is at `T`; both null when the name never had a price (it is carried at cost). */
  price_at: timestamp.nullable(),
  price_age_s: finite.int().nullable(),
  /** Gain or loss: sign x (price - average cost) x shares. */
  unrealized_usd: finite,
  entry_at: timestamp,
  /** Elapsed thread time since the first entry, in seconds: "held for 3d 4h". Not a trading-day count. */
  held_for_s: finite.int(),
  stop_price: finite.nullable(),
  /** When the stop line was first crossed: an alert flag only, the stop never exits. */
  stop_hit_at: timestamp.nullable(),
}) satisfies z.ZodType<components["schemas"]["PortfolioPositionOut"]>;

export const PortfolioOrderSchema = z.object({
  id: finite.int(),
  session_id: finite.int(),
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "stop", "stop_limit"]),
  shares: finite.int(),
  limit_price: finite.nullable(),
  stop_price: finite.nullable(),
  status: z.enum(["working", "filled", "cancelled"]),
  placed_at: timestamp,
  triggered_at: timestamp.nullable(),
  closed_at: timestamp.nullable(),
  fill_price: finite.nullable(),
  mark_id: finite.int().nullable(),
  reason: z.string().nullable(),
  tif: z.enum(["gtc", "day"]).default("gtc"),
  expires_at: timestamp.nullable().default(null),
  reduce_only: z.boolean().default(false),
}) satisfies z.ZodType<components["schemas"]["PortfolioOrderOut"]>;

export const PortfolioSchema = z.object({
  thread_id: finite.int(),
  /** `T` when the portfolio was priced; null before the thread has a clock. */
  as_of: timestamp.nullable(),
  positions: z.array(PortfolioPositionSchema),
  /** The working orders only, across the lanes. */
  orders: z.array(PortfolioOrderSchema),
  account: ClockAccountSchema.nullable(),
  label: z.string(),
}) satisfies z.ZodType<components["schemas"]["PortfolioOut"]>;

export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;
export type PortfolioOrder = z.infer<typeof PortfolioOrderSchema>;
export type Portfolio = z.infer<typeof PortfolioSchema>;
