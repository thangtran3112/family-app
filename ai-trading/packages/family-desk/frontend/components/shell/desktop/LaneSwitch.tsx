"use client";

import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { LANE_LABEL, type Lane } from "@/lib/lanes";
import styles from "./topbar.module.css";

const ORDER: readonly Lane[] = ["fundamental", "technical"];

export function LaneSwitch() {
  const { lane, setLane } = useDeskUi();
  return (
    <div className={styles.lane} role="radiogroup" aria-label="View">
      {ORDER.map((item) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={item === lane}
          className={styles.laneSegment}
          onClick={() => setLane(item)}
        >
          {LANE_LABEL[item]}
        </button>
      ))}
    </div>
  );
}
