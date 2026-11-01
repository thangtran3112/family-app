"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { practiceTabLabel, threadPageHref } from "@/lib/replay/practiceTabs";
import { threadName } from "@/lib/replay/threadView";
import { OverviewChips, OverviewShell } from "./OverviewParts";
import { PracticeTabs } from "./PracticeTabs";

/**
 * `/practice/order?thread=`: the Order tab. It names no stock and loads no replay session: a chart and its ticket open only from a
 * name she picked on the Day list (the Board of a swing thread) or the Portfolio, so this page says where to pick one. Reads the URL,
 * so the page wraps it in Suspense.
 */
export function OrderPage() {
  const raw = useSearchParams().get("thread");
  const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const query = useDeskQuery(`practice-thread:${id}`, (signal) => loadThread(id ?? 0, { signal }), { enabled: id !== null });

  if (id === null || (query.error instanceof DeskApiError && query.error.status === 404)) {
    return (
      <OverviewShell title="Practice thread" titleRef={titleRef}>
        <EmptyBlock title={PRACTICE_COPY.threadPageNotFound} />
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
        <EmptyBlock title={PRACTICE_COPY.orderPickTitle} framed>
          <span>{practiceText("orderPickBody", { list })}</span>
          <Button href={`/practice/day?id=${today.day_list_id}`} variant="primary">{practiceText("orderOpenList", { list })}</Button>
          <Button href={threadPageHref(thread.id, "portfolio")}>{PRACTICE_COPY.orderOpenPortfolio}</Button>
        </EmptyBlock>
      )}
    </OverviewShell>
  );
}
