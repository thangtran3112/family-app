"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation lets the strategy builder's beforeunload guard run. */

import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { COPY } from "@/lib/desk/freshness";
import type { ShellBand } from "@/lib/desk/viewport";
import { AlertsBell } from "./AlertsBell";
import { AvatarMenu } from "./AvatarMenu";
import { LaneSwitch } from "./LaneSwitch";
import { MarketStatusPill } from "./MarketStatusPill";
import { PrimaryNav } from "./PrimaryNav";
import { SymbolSearch } from "./SymbolSearch";
import styles from "./topbar.module.css";

export function TopBar({ band }: { band: ShellBand }) {
  const { status, connection, failed } = useDeskStatus();
  return (
    <header className={styles.bar} role="banner" data-band={band}>
      <a className={styles.wordmark} href="/">
        <span className={styles.mark} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5v4M9 15v4M15 3v6M15 15v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <rect x="7" y="9" width="4" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
            <rect x="13" y="9" width="4" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
        <span>Family Desk</span>
      </a>
      <LaneSwitch />
      <PrimaryNav />
      <span className={styles.spacer} />
      <SymbolSearch compact={band === "1180"} />
      <MarketStatusPill band={band} />
      {failed ? (
        <span className={`${styles.pill} ${styles.topBadge}`} role="status">{COPY.statusUnavailable}</span>
      ) : (
        <FreshnessBadge className={styles.topBadge} stamp={status?.quotes ?? null} session={status?.market.session} connection={connection} />
      )}
      <AlertsBell />
      <AvatarMenu />
    </header>
  );
}
