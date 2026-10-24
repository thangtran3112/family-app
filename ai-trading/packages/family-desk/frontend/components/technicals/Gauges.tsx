import type { TechnicalsSchema } from "@/lib/api/schemas";
import { countsLine, formatScore, gaugeAriaLabel, needleGeometry } from "@/lib/desk/summary";
import { formatEtTimeZone } from "@/lib/desk/format";
import { qualityPhrase } from "@/lib/desk/freshness";
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

export function BiasGauge({
  title,
  gauge,
  quality,
  asOf,
  unavailable = false,
  size = "default",
}: {
  title: string;
  gauge: Gauge;
  quality: Technicals["quality"];
  asOf: string | null;
  unavailable?: boolean;
  /** `large` is the desktop half-dial odometer with the count line; `compact` fits the right rail. */
  size?: "default" | "compact" | "large";
}) {
  const label = unavailable ? "Unavailable" : gauge.label;
  const needle = needleGeometry(gauge.score, 61, 90, 90);
  const counts = gauge.counts;
  const desktop = size !== "default";

  return (
    <section className={`${styles.gaugeCard} ${size === "large" ? styles.gaugeLarge : ""} ${size === "compact" ? styles.gaugeCompact : ""}`} aria-label={`${title} gauge`}>
      <header className={styles.blockHeader}>
        <h2>{title}</h2>
        {size !== "compact" && <span className={styles.quality}>{desktop ? qualityPhrase(quality) : qualityLabel(quality)}</span>}
      </header>
      <svg
        className={styles.gaugeSvg}
        viewBox="0 0 180 100"
        role="img"
        aria-label={desktop ? gaugeAriaLabel(title, label, unavailable ? null : gauge.score, unavailable ? null : counts) : `${title}: ${label}, score ${unavailable ? "unavailable" : formatScore(gauge.score)}`}
      >
        <path d="M 12 90 A 78 78 0 0 1 26.9 44.15" fill="none" stroke="#FF453A" strokeWidth="14" />
        <path d="M 26.9 44.15 A 78 78 0 0 1 65.9 15.82" fill="none" stroke="#FF453A80" strokeWidth="14" />
        <path d="M 65.9 15.82 A 78 78 0 0 1 114.1 15.82" fill="none" stroke="#9B9BA166" strokeWidth="14" />
        <path d="M 114.1 15.82 A 78 78 0 0 1 153.1 44.15" fill="none" stroke="#30D15880" strokeWidth="14" />
        <path d="M 153.1 44.15 A 78 78 0 0 1 168 90" fill="none" stroke="#30D158" strokeWidth="14" />
        {needle && <line x1="90" y1="90" x2={needle.x2} y2={needle.y2} stroke="#F2F2F4" strokeWidth="3" strokeLinecap="round" />}
        <circle cx="90" cy="90" r="5" fill="#F2F2F4" />
      </svg>
      <div className={`${styles.gaugeLabel} ${toneForLabel[label] ?? styles.toneNeutral}`}>{label}</div>
      <div className={styles.gaugeScore}>{unavailable ? "—" : formatScore(gauge.score)}</div>
      {desktop ? (
        <div className={styles.voteCounts}>{unavailable ? "Vote counts unavailable" : countsLine(counts)}</div>
      ) : (
      <div className={styles.voteCounts} aria-label={counts ? "Backend vote counts" : "Vote counts unavailable"}>
        {counts && !unavailable ? <>
          <span><strong className={styles.toneSell}>{counts.sell}</strong> Sell</span>
          <span><strong>{counts.neutral}</strong> Neutral</span>
          <span><strong className={styles.toneBuy}>{counts.buy}</strong> Buy</span>
        </> : <span>Vote counts unavailable</span>}
      </div>
      )}
      {size !== "compact" && <time className={styles.asOf} dateTime={asOf ?? undefined}>{asOf ? `Source bar · ${desktop ? formatEtTimeZone(asOf) : asOf}` : "Source bar unavailable"}</time>}
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
