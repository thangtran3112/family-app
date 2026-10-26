import { practiceText } from "@/lib/desk/freshness";
import dayStyles from "../day/day.module.css";

/** The star in the first column of the board: a real toggle button (Space or Enter flips it), shared with the day list's look. */
export function StarCell({ symbol, on, locked, onToggle }: { symbol: string; on: boolean; locked: boolean; onToggle: (symbol: string) => void }) {
  return (
    <button
      type="button"
      className={dayStyles.star}
      aria-pressed={on}
      aria-label={practiceText(on ? "dayUnstar" : "dayStar", { symbol })}
      disabled={locked}
      onClick={(event) => {
        // The row selects on a click; the star only stars.
        event.stopPropagation();
        onToggle(symbol);
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}
