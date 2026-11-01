import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { RailList } from "@/components/ui/RailList";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { formatBalance, threadModeLabel, threadName } from "@/lib/replay/threadView";
import type { ThreadSummary } from "@/lib/replay/threads";

/** Her threads as links to their journals (the journal's left rail and the picker): name, status and mode, balance and the simulated mark. `current` is the open thread. */
export function ThreadList({ rows, current, label }: { rows: ThreadSummary[]; current?: number; label?: string }) {
  return (
    <RailList
      client
      label={label}
      rows={rows.map((row) => ({
        id: String(row.thread.id),
        href: `/practice/journal?thread=${row.thread.id}`,
        selected: row.thread.id === current,
        label: threadName(row.thread),
        sub: `${row.thread.status === "active" ? PRACTICE_COPY.threadActive : PRACTICE_COPY.threadClosedBadge} · ${threadModeLabel(row.thread.mode)}`,
        value: (
          <>
            <span>{formatBalance(row.thread.stats.balance)}</span>
            <SimulatedBadge />
          </>
        ),
      }))}
    />
  );
}
