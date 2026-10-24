"use client";

import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { marketPillShort, marketPillText } from "@/lib/desk/freshness";
import type { ShellBand } from "@/lib/desk/viewport";
import styles from "./topbar.module.css";

export function MarketStatusPill({ band }: { band: ShellBand }) {
  const { status, failed } = useDeskStatus();
  const full = failed ? "Market status unavailable" : status ? marketPillText(status.market.session, status.market.next_open) : "Checking the market…";
  return (
    <span className={styles.pill} title={full} data-open={status?.market.session === "regular" ? "true" : undefined}>
      <span className={styles.pillDot} aria-hidden="true" />
      <span className={styles.pillText}>{status && band === "1180" ? marketPillShort(status.market.session) : full}</span>
    </span>
  );
}
