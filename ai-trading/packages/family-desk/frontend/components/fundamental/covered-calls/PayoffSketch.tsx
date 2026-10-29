import { coveredCallPayoff, scaleLinear } from "@/lib/desk/payoff";
import { formatUsd } from "@/lib/desk/mask";
import styles from "./coveredCalls.module.css";

const W = 460;
const H = 200;
const M = { left: 52, right: 14, top: 12, bottom: 28 };

/**
 * Payoff at expiry per share for the top call: the line, a numeric price axis and a numeric profit axis, the spot, the
 * breakeven and the most it can make. Per-share values, so nothing here is masked. A small SVG, no chart library (02n §f).
 */
export function PayoffSketch({ spot, strike, bid }: { spot: number | null; strike: number; bid: number }) {
  const payoff = coveredCallPayoff(spot, strike, bid);
  if (!payoff) return null;
  const x = (price: number) => scaleLinear(price, payoff.xDomain, [M.left, W - M.right]);
  const y = (pl: number) => scaleLinear(pl, payoff.yDomain, [H - M.bottom, M.top]);
  const path = payoff.points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.price).toFixed(1)} ${y(point.pl).toFixed(1)}`).join(" ");
  const cap = payoff.points.find((point) => Math.abs(point.pl - payoff.maxProfit) < 1e-9 && point.price >= strike) ?? null;
  return (
    <figure className={styles.sketch} data-testid="fund-cc-payoff" style={{ margin: 0 }}>
      <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Payoff at expiry per share: most it makes ${formatUsd(payoff.maxProfit, { cents: true })}, breaks even at ${formatUsd(payoff.breakeven, { cents: true })}`}>
        {payoff.yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line className={tick === 0 ? styles.axis : styles.grid} x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} />
            <text x={M.left - 6} y={y(tick) + 3} textAnchor="end">{formatUsd(tick)}</text>
          </g>
        ))}
        {payoff.xTicks.map((tick) => (
          <text key={`x${tick}`} x={x(tick)} y={H - M.bottom + 14} textAnchor="middle">{formatUsd(tick)}</text>
        ))}
        <line className={styles.spot} x1={x(payoff.spot)} x2={x(payoff.spot)} y1={M.top} y2={H - M.bottom} />
        <text x={x(payoff.spot) + 4} y={H - M.bottom - 6} textAnchor="start">Now {formatUsd(payoff.spot, { cents: true })}</text>
        <path className={styles.line} d={path} />
        <circle className={styles.mark} cx={x(payoff.breakeven)} cy={y(0)} r={3.5} />
        <text className={styles.markText} x={x(payoff.breakeven)} y={y(0) + 14} textAnchor="middle">Breakeven {formatUsd(payoff.breakeven, { cents: true })}</text>
        {cap && (
          <>
            <circle className={styles.mark} cx={x(cap.price)} cy={y(cap.pl)} r={3.5} />
            <text className={styles.markText} x={x(cap.price)} y={y(cap.pl) - 7} textAnchor="end">Most it makes {formatUsd(payoff.maxProfit, { cents: true })}</text>
          </>
        )}
      </svg>
      <figcaption className={styles.cap}>Profit per share at expiry · stock bought at today&apos;s price</figcaption>
    </figure>
  );
}
