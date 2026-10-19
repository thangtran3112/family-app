import type { TechnicalsSchema } from "@/lib/api/schemas";
import { qualityLabel } from "@/lib/labels";
import styles from "./technicals.module.css";

type Technicals = ReturnType<typeof TechnicalsSchema.parse>;
type Gauge = Technicals["gauges"]["summary"];

const toneForLabel: Record<string, string> = {
  "Strong Sell": styles.toneSell,
  Sell: styles.toneSell,
  Neutral: styles.toneNeutral,
  Buy: styles.toneBuy,
  "Strong Buy": styles.toneBuy,
  "warming up": styles.toneNeutral,
};

function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return `${score > 0 ? "+" : ""}${score.toFixed(2)}`;
}

export function BiasGauge({
  title,
  gauge,
  quality,
  asOf,
  unavailable = false,
}: {
  title: string;
  gauge: Gauge;
  quality: Technicals["quality"];
  asOf: string | null;
  unavailable?: boolean;
}) {
  const label = unavailable ? "Unavailable" : gauge.label;
  const score = gauge.score === null ? 0 : Math.max(-1, Math.min(1, gauge.score));
  const angle = Math.PI - ((score + 1) / 2) * Math.PI;
  const needleX = 90 + 61 * Math.cos(angle);
  const needleY = 90 - 61 * Math.sin(angle);
  const counts = gauge.counts;

  return (
    <section className={styles.gaugeCard} aria-label={`${title} gauge`}>
      <header className={styles.blockHeader}>
        <h2>{title}</h2>
        <span className={styles.quality}>{qualityLabel(quality)}</span>
      </header>
      <svg className={styles.gaugeSvg} viewBox="0 0 180 100" role="img" aria-label={`${title}: ${label}, score ${unavailable ? "unavailable" : formatScore(gauge.score)}`}>
        <path d="M 12 90 A 78 78 0 0 1 26.9 44.15" fill="none" stroke="#FF453A" strokeWidth="14" />
        <path d="M 26.9 44.15 A 78 78 0 0 1 65.9 15.82" fill="none" stroke="#FF453A80" strokeWidth="14" />
        <path d="M 65.9 15.82 A 78 78 0 0 1 114.1 15.82" fill="none" stroke="#9B9BA166" strokeWidth="14" />
        <path d="M 114.1 15.82 A 78 78 0 0 1 153.1 44.15" fill="none" stroke="#30D15880" strokeWidth="14" />
        <path d="M 153.1 44.15 A 78 78 0 0 1 168 90" fill="none" stroke="#30D158" strokeWidth="14" />
        {gauge.score !== null && <line x1="90" y1="90" x2={needleX} y2={needleY} stroke="#F2F2F4" strokeWidth="3" strokeLinecap="round" />}
        <circle cx="90" cy="90" r="5" fill="#F2F2F4" />
      </svg>
      <div className={`${styles.gaugeLabel} ${toneForLabel[label] ?? styles.toneNeutral}`}>{label}</div>
      <div className={styles.gaugeScore}>{unavailable ? "—" : formatScore(gauge.score)}</div>
      <div className={styles.voteCounts} aria-label={counts ? "Backend vote counts" : "Vote counts unavailable"}>
        {counts && !unavailable ? <>
          <span><strong className={styles.toneSell}>{counts.sell}</strong> Sell</span>
          <span><strong>{counts.neutral}</strong> Neutral</span>
          <span><strong className={styles.toneBuy}>{counts.buy}</strong> Buy</span>
        </> : <span>Vote counts unavailable</span>}
      </div>
      <time className={styles.asOf} dateTime={asOf ?? undefined}>{asOf ? `Source bar · ${asOf}` : "Source bar unavailable"}</time>
    </section>
  );
}

export function Gauges({ technicals }: { technicals: Technicals }) {
  const unavailable = technicals.quality === "unavailable";
  return (
    <div className={styles.gauges}>
      <BiasGauge title="Oscillators" gauge={technicals.gauges.oscillators} quality={technicals.quality} asOf={technicals.as_of} unavailable={unavailable} />
      <BiasGauge title="Desk Technical Bias" gauge={technicals.gauges.summary} quality={technicals.quality} asOf={technicals.as_of} unavailable={unavailable} />
      <BiasGauge title="Moving averages" gauge={technicals.gauges.moving_averages} quality={technicals.quality} asOf={technicals.as_of} unavailable={unavailable} />
    </div>
  );
}
