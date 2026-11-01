"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { Badge } from "@/components/ui/Badge";
import { Delta } from "@/components/ui/Delta";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import type { Tone } from "@/components/ui/tone";
import type { WatchlistTable } from "@/lib/api/schemas";
import { withPriorities } from "@/lib/desk/columns";
import { formatPrice, formatRatio } from "@/lib/desk/format";
import { SYMBOL_HREF } from "@/lib/lanes";
import { biasUiTone } from "@/lib/desk/workspace";
import { strategyChips } from "@/lib/desk/watchlistView";
import styles from "./watchlistDesktop.module.css";
import { alertNewHref } from "@/lib/desk/hrefs";

type Row = WatchlistTable["rows"][number];

/** A Badge that ellipsizes inside its slot (150 px, 220 px when alone: see the CSS), so two chips and a "+N" fit the table. */
function ChipSlot({ tone, title, children }: { tone: Tone; title: string; children: ReactNode }) {
  return (
    <span className={styles.chipSlot}>
      <Badge tone={tone} title={title}><span className={styles.chipText}>{children}</span></Badge>
    </span>
  );
}

// 1180 drops RVOL, then the bias label (lib/desk/columns.ts, BOARD_PRIORITIES.watchlist).
const COLUMNS = withPriorities<DenseColumn<Row>>(
  [
    {
      key: "symbol",
      label: "Symbol",
      fill: true,
      render: (row) => (
        <span className={styles.symbol}>
          {row.symbol}
          <span className={styles.name}>{row.name}</span>
        </span>
      ),
    },
    { key: "last", label: "Last", align: "right", sortValue: (row) => row.last, render: (row) => formatPrice(row.last) },
    {
      key: "change_pct",
      label: "Chg %",
      align: "right",
      sortValue: (row) => row.change_pct,
      render: (row) => <Delta value={row.change_pct} />,
    },
    {
      key: "rvol_10d",
      label: "RVOL",
      align: "right",
      sortValue: (row) => row.rvol_10d,
      render: (row) => formatRatio(row.rvol_10d),
    },
    {
      key: "bias_label",
      label: "Bias",
      render: (row) => <Delta tone={biasUiTone(row.bias_label)}>{row.bias_label}</Delta>,
    },
    {
      key: "tags",
      label: "Strategy",
      render: (row) => {
        const { shown, hidden } = strategyChips(row.tags);
        const rest = hidden.map((chip) => chip.text).join(", ");
        return (
          <>
            {shown.map((chip, index) => (
              <ChipSlot key={index} tone={chip.tone} title={chip.text}>{chip.text}</ChipSlot>
            ))}
            {hidden.length > 0 && (
              <ChipSlot tone="neutral" title={rest}>
                +{hidden.length}
                <span className="sr-only"> more: {rest}</span>
              </ChipSlot>
            )}
          </>
        );
      },
    },
  ],
  "watchlist",
);

export function WatchlistTableDesktop({ rows, dim }: { rows: WatchlistTable["rows"]; dim: boolean }) {
  const router = useRouter();
  // Watchlists is shared by Technical and Fundamental: a row opens that mode's symbol page (ADR-0014).
  const { lane } = useDeskUi();
  return (
    <DenseTable
      caption="Watchlist"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.symbol}
      dim={dim}
      onSelect={(row) => {
        const href = SYMBOL_HREF[lane]?.(row.symbol);
        if (href) router.push(href);
      }}
      rowActions={(row) => (
        <a href={alertNewHref({ symbol: row.symbol })} className={styles.link}>+ Alert</a>
      )}
    />
  );
}
