"use client";

import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { marketPillOpen, marketPillShort, marketPillText, resolveFreshness } from "@/lib/desk/freshness";
import type { ShellBand } from "@/lib/desk/viewport";
import styles from "./topbar.module.css";

export function MarketStatusPill({ band }: { band: ShellBand }) {
  const { status, failed, connection } = useDeskStatus();
  const full = failed ? "Market status unavailable" : status ? marketPillText(status.market.session, status.market.next_open) : "Checking the market…";
  // The quote badge beside it already says "Market closed": the pill drops that prefix and keeps what is new, when it opens (D-107). The title keeps the whole text.
  const shown = status && band === "1180" ? marketPillShort(status.market.session) : full.replace(/^Market closed · (.)/, (_, first: string) => first.toUpperCase());
  // "Market open" is true of the market, not of the numbers: the dot goes green only while the quotes are current too (V-Today-01).
  const quotes = resolveFreshness({ stamp: status?.quotes ?? null, session: status?.market.session, connection, feed: true });
  const open = status !== null && marketPillOpen(status.market.session, quotes);
  return (
    <span className={styles.pill} title={full} data-open={open ? "true" : undefined} data-stale={status?.market.session === "regular" && quotes.stale ? "true" : undefined}>
      <span className={styles.pillDot} aria-hidden="true" />
      <span className={styles.pillText}>{shown}</span>
    </span>
  );
}
