import { Badge } from "@/components/ui/Badge";
import { formatNumber } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import styles from "./panels.module.css";

export type ArmedStrategyRow = {
  key: string;
  name: string;
  bias: "bullish" | "bearish" | "neutral" | null | undefined;
  fires: number;
};

// The bias is a word, so the meaning survives without colour; green and red only reinforce it.
const BIAS_WORD = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" } as const;
const BIAS_TONE = { bullish: "up", bearish: "down", neutral: "neutral" } as const;

export function ArmedStrategiesList({ armed }: { armed: ArmedStrategyRow[] }) {
  if (armed.length === 0) return <p className={styles.muted}>{PRACTICE_COPY.noArmed}</p>;
  return (
    <ul className={styles.list}>
      {armed.map((strategy) => (
        <li key={strategy.key} className={styles.row}>
          <span className={styles.armedName}>{strategy.name}</span>
          {strategy.bias && (
            <Badge tone={BIAS_TONE[strategy.bias]}>{BIAS_WORD[strategy.bias]}</Badge>
          )}
          <span className={styles.detail}>
            {strategy.fires === 1 ? "1 fire so far" : `${formatNumber(strategy.fires, 0)} fires so far`}
          </span>
        </li>
      ))}
    </ul>
  );
}
