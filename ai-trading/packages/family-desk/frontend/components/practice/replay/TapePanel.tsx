"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { isQuietTape, paceOf, type ReplayView } from "@/lib/replay/feedState";
import { etTapeClock } from "@/lib/replay/time";
import { fastTapeText, haltedTapeText, tapeRows, type SizeFilterId, type TapeDisplayRow } from "@/lib/replay/tape";
import { FeedLabel } from "./FeedLabel";
import { TapeFilters } from "./TapeFilters";
import { TapePace } from "./TapePace";
import styles from "./panels.module.css";

// The time & sales tape (02o §a3): newest prints first, tick colours, big prints in amber, size filter chips,
// the pace meter and the honest labels. The table scrolls inside the panel; the panel never grows the page.

export type TapePanelProps = {
  view: Pick<ReplayView, "tape" | "tapeMeta" | "revealedThrough" | "windowStart" | "paceSamples" | "quietS">;
  filterId: SizeFilterId;
  onFilter: (id: SizeFilterId) => void;
  refreshing?: boolean;
};

const TONE_CLASS = { up: styles.up, down: styles.down, same: styles.same } as const;

const COLUMNS: DenseColumn<TapeDisplayRow>[] = [
  { key: "time", label: "Time", render: (row) => <span className={row.big ? styles.bigTime : undefined}>{etTapeClock(row.t)}</span> },
  {
    key: "price",
    label: "Price",
    align: "right",
    render: (row) => <span className={row.big ? styles.bigPrice : TONE_CLASS[row.tone]}>{row.price}</span>,
  },
  { key: "size", label: "Size", align: "right", render: (row) => row.size },
];

export function TapePanel({ view, filterId, onFilter, refreshing = false }: TapePanelProps) {
  const rows = tapeRows(view);
  const fast = fastTapeText(view.tapeMeta);
  const halted = haltedTapeText(view.quietS);
  const quiet = halted === null && view.tape.length > 0 && isQuietTape(view);

  return (
    <section className={styles.tape}>
      <header className={styles.tapeHeader}>
        {view.tapeMeta && <FeedLabel feed={view.tapeMeta.feed} />}
      </header>
      <TapeFilters value={filterId} onChange={onFilter} />
      <TapePace pace={paceOf(view)} />
      {fast && <p className={styles.muted}>{fast}</p>}
      {quiet && <p className={styles.muted}>{PRACTICE_COPY.quietTape}</p>}
      {halted && <p className={styles.warn} role="status">{halted}</p>}
      <div className={styles.tapeTable} aria-busy={refreshing || undefined}>
        <DenseTable
          caption="Time and sales"
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.key}
          density="compact"
          empty={<p className={styles.muted}>Waiting for the first print</p>}
        />
      </div>
      <p className={styles.legend}>Colours show the tick rule: up-tick green, down-tick red, same price grey</p>
    </section>
  );
}
