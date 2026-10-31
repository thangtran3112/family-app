"use client";

import { usePathname } from "next/navigation";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { isNavActive, LANE_LABEL, LANE_SUMMARY, laneForPath, PRIMARY_NAV, type Lane } from "@/lib/lanes";
import styles from "./topbar.module.css";

// Technical first: the practice-heavy household's default lane (5R).
const ORDER: readonly Lane[] = ["technical", "fundamental"];

/** The chip's tooltip. A chip is never disabled: switching lanes is always allowed, but on a route the other lane does not have it says what the switch leaves. */
function chipTitle(item: Lane, lane: Lane, pathname: string): string {
  const owner = laneForPath(pathname);
  if (item === lane || owner !== lane) return LANE_SUMMARY[item];
  const screen = PRIMARY_NAV[lane].find((nav) => isNavActive(nav.href, pathname, nav.match))?.label;
  return `Leaves ${screen ?? "this screen"} · ${LANE_LABEL[lane]}-only screen`;
}

export function LaneSwitch() {
  const { lane, setLane } = useDeskUi();
  const pathname = usePathname() ?? "/";
  return (
    <div className={styles.laneGroup}>
      <span className={styles.laneCaption} aria-hidden="true">
        View
      </span>
      <div className={styles.lane} role="radiogroup" aria-label="View">
        {ORDER.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={item === lane}
            className={styles.laneSegment}
            title={chipTitle(item, lane, pathname)}
            onClick={() => setLane(item)}
          >
            {LANE_LABEL[item]}
          </button>
        ))}
      </div>
    </div>
  );
}
