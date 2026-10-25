import type { Stamp } from "@/lib/api/schemas";
import { asOfLine } from "@/lib/desk/freshness";
import styles from "./AsOfLine.module.css";

/** One muted line with the data's own date, quality and source: "As of last close · Thu 2026-10-15 · 4:00 PM ET · Alpaca". */
export function AsOfLine({ stamp }: { stamp: Stamp | null }) {
  return <p className={styles.line}>{asOfLine(stamp)}</p>;
}
