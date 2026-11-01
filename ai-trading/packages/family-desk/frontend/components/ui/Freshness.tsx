"use client";

import { useDeskFeedStamp, useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { formatEtTimeZone } from "@/lib/desk/format";
import { COPY, marketPillView, resolveFreshness, statusBarText, type FreshnessInput, type FreshnessView } from "@/lib/desk/freshness";
import type { ShellBand } from "@/lib/desk/viewport";
import styles from "./Freshness.module.css";
import type { Tone } from "./tone";

/** The freshness of a page's data, read against the Desk feed: every badge, dim and stale mark on a screen goes through here, so they cannot disagree. */
export function useFreshness(input: FreshnessInput): FreshnessView {
  const feedStamp = useDeskFeedStamp();
  return resolveFreshness({ ...input, feedStamp: input.feedStamp ?? feedStamp });
}

type Layout = { /** Layout only (flex, margin, max-width); never colour, size or type. */ className?: string };

export type FreshnessProps =
  /** The badge for one stamp: Live, Delayed 15 min, Quotes paused · 2 min ago… (02l §c3). */
  | (FreshnessInput & Layout & { variant?: "badge" })
  /** The top-bar market pill: open or closed, and when it opens. Reads /status itself. */
  | (Layout & { variant: "pill"; band: ShellBand })
  /** The status-bar phrasing: "Quotes live · IBKR" and the last-update time. Reads /status itself; renders spans for the bar's flex row. */
  | { variant: "statusBar" }
  /** A fixed message in the same chrome (the replay badge, "Status unavailable"). */
  | (Layout & { variant: "note"; label: string; tone?: Tone });

/** The one freshness primitive. Wording comes from lib/desk/freshness.ts only. */
export function Freshness(props: FreshnessProps) {
  switch (props.variant) {
    case "pill": return <MarketPill band={props.band} className={props.className} />;
    case "statusBar": return <StatusBarLine />;
    case "note": return <Chip className={props.className} variant="note" tone={props.tone} title={props.label} text={props.label} />;
    default: return <Badge {...props} />;
  }
}

function Chip({ className, variant, tone, title, text, dot, state, open, stale }: { className?: string; variant: string; tone?: Tone; title?: string; text: string; dot?: boolean; state?: string; open?: boolean; stale?: boolean }) {
  return (
    <span
      className={`${styles.root} ${className ?? ""}`}
      data-variant={variant}
      data-state={state}
      data-tone={tone}
      data-open={open ? "true" : undefined}
      data-stale={stale ? "true" : undefined}
      role={variant === "pill" ? undefined : "status"}
      title={title}
    >
      {(dot || variant === "pill") && <span className={styles.dot} aria-hidden="true" />}
      <span className={styles.label}>{text}</span>
    </span>
  );
}

function Badge(props: FreshnessInput & Layout) {
  const { className, ...input } = props;
  const view = useFreshness(input);
  return <Chip className={className} variant="badge" state={view.state} tone={view.tone} title={view.label} text={view.label} dot={view.dot} />;
}

function MarketPill({ band, className }: { band: ShellBand; className?: string }) {
  const { status, failed, connection } = useDeskStatus();
  const pill = marketPillView({ market: status?.market ?? null, quotes: status?.quotes ?? null, connection, failed, band });
  return <Chip className={className} variant="pill" title={pill.full} text={pill.shown} open={pill.open} stale={pill.stale} />;
}

function StatusBarLine() {
  const { status, failed, connection } = useDeskStatus();
  const quotes = status?.quotes ?? null;
  const text = failed ? COPY.statusUnavailable : statusBarText({ stamp: quotes, session: status?.market.session, connection, feed: true });
  return (
    <>
      <span>{text}</span>
      {quotes?.as_of && <span>Last update {formatEtTimeZone(quotes.as_of)}</span>}
    </>
  );
}
