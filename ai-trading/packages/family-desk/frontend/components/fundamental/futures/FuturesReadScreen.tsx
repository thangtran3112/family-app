"use client";

import Link from "next/link";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { deskFetch } from "@/lib/api/client";
import { FuturesSpecsSchema } from "@/lib/api/schemas";
import { formatEtDay } from "@/lib/desk/format";
import { COPY } from "@/lib/desk/freshness";
import { nextRoll, READ_ROOTS, ROOT_NAMES, todayEt, type ReadRoot } from "@/lib/desk/futuresRead";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "../fundamental.module.css";
import local from "./futuresRead.module.css";

type Row = { root: ReadRoot; name: string; next: string | null };

const UNAVAILABLE = "—";

/** FD6 Futures reading (02n §b3): reading only. Prices wait for futures quotes, so each price cell is a dash and the state is said once, in words. */
export function FuturesReadScreen() {
  const { setLane } = useDeskUi();
  // The shared reference route, not the gated readings route: the roll calendar is real, the prices are not connected.
  const specs = useDeskQuery("futures-read-specs", (signal) => deskFetch("/api/desk/futures/specs", FuturesSpecsSchema, { signal }));

  const rows: Row[] = READ_ROOTS.map((root) => {
    const spec = specs.data?.find((item) => item.root === root);
    return { root, name: ROOT_NAMES[root], next: spec ? nextRoll(spec.roll_dates, todayEt(new Date())) : null };
  });
  const columns: DenseColumn<Row>[] = [
    { key: "root", label: "Contract", render: (row) => <strong>/{row.root}</strong> },
    { key: "name", label: "Name", render: (row) => row.name },
    { key: "last", label: "Last", align: "right", render: () => UNAVAILABLE },
    { key: "change", label: "Day change", align: "right", render: () => UNAVAILABLE },
    { key: "week", label: "Week range", align: "right", render: () => UNAVAILABLE },
    { key: "next_roll", label: "Next roll", align: "right", render: (row) => (row.next ? formatEtDay(row.next) : UNAVAILABLE) },
  ];

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <h1 className={styles.pageTitle}>Futures</h1>
        <Link className={styles.link} href="/futures/specs">Contract sizes and roll calendar</Link>
      </header>
      <p className={`${styles.banner} ${local.reading}`} role="note" data-testid="futures-reading-only">
        <span>{COPY.futuresReadingOnly}</span>
        {/* A full navigation, like the rest of the shell: the Technical view owns /futures. */}
        <a className={styles.button} href="/futures" onClick={() => setLane("technical")}>Switch to Technical</a>
      </p>
      <section className={styles.panel} aria-label="Futures reading">
        {specs.error !== null && specs.data === null ? (
          <ErrorBlock subject="futures reference" onRetry={specs.refresh} />
        ) : specs.data === null ? (
          <LoadingBlock label="Loading futures…" height={160} />
        ) : (
          <DenseTable caption="Futures reading" columns={columns} rows={rows} rowKey={(row) => row.root} />
        )}
        <p className={styles.notice} role="status" data-testid="futures-deferred">{COPY.futuresDeferred}</p>
      </section>
    </div>
  );
}
