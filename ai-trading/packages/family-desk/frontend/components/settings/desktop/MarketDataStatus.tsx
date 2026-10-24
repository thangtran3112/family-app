"use client";

import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import type { DeskStatus } from "@/lib/api/schemas";
import { alertsBanner, marketDataLine } from "@/lib/desk/freshness";
import { slotsText } from "@/lib/watchlists/slots";
import styles from "./settingsDesktop.module.css";

const GATEWAY_LINE: Record<DeskStatus["gateway"], string> = {
  not_configured: "IBKR gateway: not connected",
  connected: "IBKR gateway: connected",
  reconnecting: "IBKR gateway: reconnecting…",
  down: "IBKR gateway: unavailable",
};

/** Plain-words data sources, read from the shell's shared `/status` (02m §a3.8). */
export function MarketDataStatus() {
  const { status, failed } = useDeskStatus();
  if (status === null) {
    return <p className={styles.helper}>{failed ? "Data source status is unavailable right now" : "Checking data sources…"}</p>;
  }
  const lines = [
    marketDataLine("Quotes", status.quotes),
    marketDataLine("Scans", status.scans),
    GATEWAY_LINE[status.gateway],
    `Quote slots: ${slotsText(status.streaming_slots)}`,
    alertsBanner(status.alerts.state) ?? "Alerts are running",
  ];
  return (
    <ul className={styles.lines}>
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}
