"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { Field, Input } from "@/components/ui/Field";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";
import { PracticeNotice } from "@/components/practice/PracticeNotice";
import { EmptyBlock, ErrorBlock, LoadingBlock, QueryBoundary } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThread, startDaySession } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { practiceTabLabel, threadPageHref } from "@/lib/replay/practiceTabs";
import { heldBlocked, heldHref, heldWhere, orderNames, type OrderName } from "@/lib/replay/orderView";
import { problemMessage } from "@/lib/replay/setup";
import { loadAnyDayList } from "@/lib/replay/swingApi";
import { threadName } from "@/lib/replay/threadView";
import hub from "./hub.module.css";
import styles from "./landing.module.css";
import { OverviewChips, OverviewShell } from "./OverviewParts";
import { PracticeTabs } from "./PracticeTabs";

/**
 * `/practice/order?thread=`: the Order tab. It loads no replay session until she picks: it lists the names of the day that is open
 * (the Day list, or the Board of a swing thread), filtered by what she types, and a name opens its chart and ticket at the day clock,
 * the same call the Day list makes. The Day list and the Portfolio stay one link away. Reads the URL, so the page wraps it in Suspense.
 */
export function OrderPage() {
  const raw = useSearchParams().get("thread");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null });

  if (id === null) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        <ThreadPicker />
      </OverviewShell>
    );
  }
  if (query.error instanceof DeskApiError && query.error.status === 404) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        <PracticeNotice title={PRACTICE_COPY.threadPageNotFound} />
      </OverviewShell>
    );
  }
  if (query.data === null) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        {query.error === null ? <LoadingBlock label={PRACTICE_COPY.threadPageLoading} height={160} /> : <ErrorBlock message={PRACTICE_COPY.threadPageLoadError} onRetry={query.refresh} />}
      </OverviewShell>
    );
  }

  const { thread, today } = query.data;
  const list = practiceTabLabel("day", thread.mode);
  return (
    <OverviewShell
      title={threadName(thread)}
      titleRef={titleRef}
      aside={<OverviewChips thread={thread} />}
      tabs={<PracticeTabs threadId={thread.id} active="order" mode={thread.mode} back={false} />}
    >
      {today === null ? (
        <EmptyBlock title={PRACTICE_COPY.orderNoDayTitle} framed>
          <span>{PRACTICE_COPY.orderNoDayBody}</span>
          <Button href={threadPageHref(thread.id)} variant="primary">{PRACTICE_COPY.portfolioNoDayLink}</Button>
        </EmptyBlock>
      ) : (
        <section className={styles.panel} aria-labelledby="order-pick-title">
          <h2 id="order-pick-title" className={styles.panelTitle}>{PRACTICE_COPY.orderPickTitle}</h2>
          <p className={hub.muted}>{practiceText("orderPickBody", { list })}</p>
          <NamePicker dayListId={today.day_list_id} />
          <div className={hub.inline}>
            <Button href={`/practice/day?id=${today.day_list_id}`}>{practiceText("orderOpenList", { list })}</Button>
            <Button href={threadPageHref(thread.id, "portfolio")}>{PRACTICE_COPY.orderOpenPortfolio}</Button>
          </div>
        </section>
      )}
    </OverviewShell>
  );
}

const NAME_COLUMNS: DenseColumn<OrderName>[] = [
  { key: "symbol", label: "Symbol", render: (row) => row.symbol },
  { key: "status", label: "Today", render: (row) => row.status },
];

/** The names of the open day, typed down to a match; a click opens the name's chart at the day clock (ponytail: no paging, the list is capped by the plan). */
function NamePicker({ dayListId }: { dayListId: number }) {
  const router = useRouter();
  const [find, setFind] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const query = useDeskQuery(`practice-order-names:${dayListId}`, (signal) => loadAnyDayList(dayListId, {}, { signal }));

  const open = async (symbol: string, held: OrderName["held"]) => {
    if (opening !== null) return;
    if (held !== null) return setMessage(heldBlocked(held)); // the open would be a 409: the name is open elsewhere
    setOpening(symbol);
    setMessage(null);
    try {
      const session = await startDaySession(dayListId, symbol);
      router.push(`/practice/replay?id=${session.id}`);
    } catch (error) {
      setMessage(problemMessage(error, PRACTICE_COPY.dayStartError));
      setOpening(null);
    }
  };

  return (
    <QueryBoundary query={query} loading="Loading today's names…" height={96} message={PRACTICE_COPY.dayLoadError}>
      {(list) => {
        const rows = orderNames(list, find);
        if (list.candidates.length === 0) return <EmptyBlock title={PRACTICE_COPY.orderNoNames} />;
        return (
          <>
            <Field id="order-find" label={PRACTICE_COPY.orderFind}>
              <Input type="search" autoComplete="off" value={find} onChange={(event) => setFind(event.currentTarget.value)} />
            </Field>
            {message && <p className={styles.notice} role="alert">{message}</p>}
            <DenseTable
              caption={PRACTICE_COPY.orderNames}
              columns={NAME_COLUMNS}
              rows={rows}
              rowKey={(row) => row.symbol}
              onSelect={(row) => void open(row.symbol, row.held)}
              empty={PRACTICE_COPY.orderFindNone}
              rowActions={(row) => {
                if (row.held !== null) {
                  return (
                    <Button size="sm" href={heldHref(row.held)} aria-label={practiceText("dayHeldGoLabel", { symbol: row.symbol, where: heldWhere(row.held) })}>
                      {PRACTICE_COPY.dayHeldGo}
                    </Button>
                  );
                }
                const here = opening === row.symbol;
                return (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={opening !== null}
                    loading={here}
                    aria-label={here ? undefined : practiceText("dayOpen", { symbol: row.symbol })}
                    onClick={() => void open(row.symbol, null)}
                  >
                    {here ? practiceText("dayOpening", { symbol: row.symbol }) : PRACTICE_COPY.dayOpenButton}
                  </Button>
                );
              }}
            />
          </>
        );
      }}
    </QueryBoundary>
  );
}
