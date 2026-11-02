import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { RailList } from "@/components/ui/RailList";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { formatBalance, threadModeLabel, threadName } from "@/lib/replay/threadView";
import type { ThreadSummary } from "@/lib/replay/threads";

const journalHref = (threadId: number): string => `/practice/journal?thread=${threadId}`;

/** Her threads as links (the journal's left rail and the picker): name, status and mode, balance and the simulated mark. `current` is the open thread. A link goes to the thread's journal unless `href` says where else (D-183). */
export function ThreadList({ rows, current, label, href = journalHref }: { rows: ThreadSummary[]; current?: number; label?: string; href?: (threadId: number) => string }) {
  return (
    <RailList
      client
      label={label}
      rows={rows.map((row) => ({
        id: String(row.thread.id),
        href: href(row.thread.id),
        selected: row.thread.id === current,
        label: threadName(row.thread),
        // The name keeps the row to itself: the balance and the mark sit on the line under it, and the status and mode on the line under that,
        // at every width (D-171): one line was 280 px of text in a 191 to 231 px rail.
        sub: (
          <>
            <span>{formatBalance(row.thread.stats.balance)}</span> <SimulatedBadge />{" "}
            <br />
            {row.thread.status === "active" ? PRACTICE_COPY.threadActive : PRACTICE_COPY.threadClosedBadge} · {threadModeLabel(row.thread.mode)}
          </>
        ),
      }))}
    />
  );
}
