"use client";
// Plain links: full document navigation lets the strategy builder's beforeunload guard run.

import { useDeskStatus, useDeskUi } from "@/components/shell/desktop/DeskContext";
import { Freshness } from "@/components/ui/Freshness";
import { COPY } from "@/lib/desk/freshness";
import type { ShellBand } from "@/lib/desk/viewport";
import { LANE_HOME, shows } from "@/lib/lanes";
import { AlertsBell } from "./AlertsBell";
import { AvatarMenu } from "./AvatarMenu";
import { useReplayBadge } from "./PracticeChrome";
import { MaskToggle } from "./MaskToggle";
import { ModeMenu } from "./ModeMenu";
import { PrimaryNav } from "./PrimaryNav";
import { SymbolSearch } from "./SymbolSearch";
import styles from "./topbar.module.css";

/** The 48 px top bar. Which parts show is the mode's row in the section table (`shows`, ADR-0014); Backtest has no live-market parts. */
export function TopBar({ band }: { band: ShellBand }) {
  const { status, connection, failed } = useDeskStatus();
  const replayBadge = useReplayBadge();
  const { lane } = useDeskUi();
  return (
    <header className={styles.bar} role="banner" data-band={band}>
      <a className={styles.wordmark} href={LANE_HOME[lane]}>
        <span className={styles.mark} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5v4M9 15v4M15 3v6M15 15v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <rect x="7" y="9" width="4" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
            <rect x="13" y="9" width="4" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
        <span>Family Desk</span>
      </a>
      <ModeMenu />
      <PrimaryNav />
      <span className={styles.spacer} />
      {shows(lane, "search") && <SymbolSearch compact={band === "1180"} />}
      {shows(lane, "mask") && <MaskToggle />}
      {/* The live market status says nothing about a replayed day, so it steps aside while a replay runs (and in Backtest always). */}
      {!replayBadge && shows(lane, "marketPill") && <Freshness variant="pill" band={band} />}
      {replayBadge ? (
        <Freshness variant="note" className={`${styles.topBadge} ${styles.replayBadge}`} label={replayBadge} tone="warn" />
      ) : !shows(lane, "freshness") ? null : failed ? (
        <Freshness variant="note" className={styles.topBadge} label={COPY.statusUnavailable} />
      ) : (
        <Freshness className={styles.topBadge} stamp={status?.quotes ?? null} session={status?.market.session} connection={connection} feed />
      )}
      {shows(lane, "alertsBell") && <AlertsBell />}
      <AvatarMenu />
    </header>
  );
}
