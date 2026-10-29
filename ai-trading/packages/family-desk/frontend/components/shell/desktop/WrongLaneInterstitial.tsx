"use client";

import { COPY, wrongLaneText } from "@/lib/desk/freshness";
import { LANE_LABEL, laneForPath } from "@/lib/lanes";
import { useDeskUi } from "./DeskContext";
import styles from "./interstitial.module.css";

/** "This screen belongs to the Fundamental view · Switch view" (02m §c1). */
export function WrongLaneInterstitial({ pathname }: { pathname: string }) {
  const { setLane } = useDeskUi();
  const target = laneForPath(pathname);
  if (target === "shared") return null;
  return (
    <section className={styles.panel} aria-labelledby="wrong-lane-title">
      <h1 id="wrong-lane-title" className={styles.title}>{wrongLaneText(LANE_LABEL[target])}</h1>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => setLane(target)}>{COPY.switchView}</button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full navigation, like the rest of the shell */}
        <a className={styles.secondary} href="/">Back to Today</a>
      </div>
    </section>
  );
}
