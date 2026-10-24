import type { AlertStrategyFire } from "@/lib/api/schemas";
import { sparkline } from "@/lib/desk/sparkline";
import styles from "./alerts.module.css";

const WIDTH = 120;
const HEIGHT = 40;

/** The 15-minute price picture around one fire (D9 recent fires). Colour follows the move; short data reads "No chart". */
export function FireThumb({ bars }: { bars: AlertStrategyFire["thumb"]["bars"] }) {
  const shape = sparkline(bars.map((bar) => bar.c), WIDTH, HEIGHT);
  if (!shape.last) return <span className={styles.noChart}>No chart</span>;
  return (
    <svg
      className={styles.thumb}
      data-tone={shape.up ? "up" : "down"}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="Price around the alert, 15 minute bars"
    >
      <path d={shape.area} fill="currentColor" fillOpacity={0.2} />
      <path d={shape.line} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={shape.last.x} cy={shape.last.y} r={2.5} fill="currentColor" />
    </svg>
  );
}
