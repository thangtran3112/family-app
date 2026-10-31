// Chart geometry for the covered-call screens (02n §f: small SVGs with numeric axes, no chart library). Pure: the inputs
// are the engine's own spot, strike and bid; this only draws them. Per-share values, so the axes are never masked.
import { niceTicks } from "./ticks.ts";


/** Maps `value` from the data domain onto the pixel range (the y axis passes a reversed range). */
export const scaleLinear = (value: number, domain: readonly [number, number], range: readonly [number, number]): number =>
  domain[1] === domain[0] ? range[0] : range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);

export type PayoffPoint = { price: number; pl: number };
export type Payoff = {
  /** Straight segments: the low end, the strike (when inside the range) and the high end. */
  points: PayoffPoint[];
  /** The most the position can make per share: strike - spot + bid. */
  maxProfit: number;
  /** The share price where the position breaks even at expiry: spot - bid. */
  breakeven: number;
  spot: number;
  strike: number;
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yTicks: number[];
};

/** Profit or loss per share at expiry for stock bought at `spot` plus one short call: (price - spot) + bid - max(0, price - strike). */
export const payoffAt = (price: number, spot: number, strike: number, bid: number): number => price - spot + bid - Math.max(0, price - strike);

/** The covered-call payoff over spot × 0.8 to spot × 1.2, or null when an input is not a usable positive number. */
export function coveredCallPayoff(spot: number | null, strike: number, bid: number): Payoff | null {
  if (spot === null || ![spot, strike, bid].every(Number.isFinite) || spot <= 0 || strike <= 0 || bid < 0) return null;
  const low = spot * 0.8;
  const high = spot * 1.2;
  const prices = [low, ...(strike > low && strike < high ? [strike] : []), high];
  const points = prices.map((price) => ({ price, pl: payoffAt(price, spot, strike, bid) }));
  const pls = points.map((point) => point.pl);
  const yMin = Math.min(...pls, 0);
  const yMax = Math.max(...pls, 0);
  const pad = (yMax - yMin) * 0.08 || 1;
  const yDomain: [number, number] = [yMin - pad, yMax + pad];
  const xDomain: [number, number] = [low, high];
  return {
    points,
    maxProfit: strike - spot + bid,
    breakeven: spot - bid,
    spot,
    strike,
    xDomain,
    yDomain,
    xTicks: niceTicks(low, high, { inside: true }),
    yTicks: niceTicks(yDomain[0], yDomain[1], { inside: true }),
  };
}
