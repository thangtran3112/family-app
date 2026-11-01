"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BackLink } from "@/components/practice/hub/BackLink";
import { Tabs } from "@/components/ui/Tabs";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadThread } from "@/lib/desk/replay";
import { PRACTICE_TABS, practiceTabLabel, resolveTabHref, threadPageHref, type PracticeTab, type TabLoaders } from "@/lib/replay/practiceTabs";
import { loadAnyDayList } from "@/lib/replay/swingApi";
import landing from "./landing.module.css";
import styles from "./PracticeTabs.module.css";

/** `idBase` of the strip: the thread page's `TabPanel` uses the same one. */
export const PRACTICE_TABS_ID = "practice-tabs";

const LOADERS: TabLoaders = {
  today: async (id) => (await loadThread(id)).today,
  sessions: async (dayListId) => (await loadAnyDayList(dayListId)).sessions.map((session) => session.id),
};

/**
 * The strip of one practice thread: Summary, Portfolio, Day list (Board for a swing thread), Trade, Journal. It stands in the
 * row the "Back to practice" link used to take, on the thread page, the day list, the replay workspace and the journal. A click
 * asks the server where the thread's open day and session are now (`resolveTabHref`), so a tab never sends her to a stale id.
 * A session with no thread has no strip and keeps the plain back link. Summary and Portfolio share the thread page, which wraps
 * its content in a `TabPanel` and passes `panelMounted`; on the other screens the tabs are navigation and name no panel.
 */
export function PracticeTabs({
  threadId,
  active,
  mode = "day",
  back = true,
  panelMounted = false,
}: {
  threadId: number | null;
  active: PracticeTab;
  mode?: "day" | "swing";
  /** The thread page already shows its own back link in its header. */
  back?: boolean;
  panelMounted?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // The latest click wins: an answer that comes back after a newer click is dropped.
  const latest = useRef(0);
  if (threadId === null) return <BackLink threadId={null} />;

  function go(tab: PracticeTab) {
    if (tab === active || threadId === null) return;
    const click = ++latest.current;
    setBusy(true);
    resolveTabHref(threadId, tab, LOADERS)
      .catch(() => threadPageHref(threadId))
      .then((href) => {
        if (click !== latest.current) return;
        setBusy(false);
        // Summary with no open day for Day list or Trade is the page she is on: no second history entry.
        if (href !== `${window.location.pathname}${window.location.search}`) router.push(href, { scroll: false });
      });
  }

  return (
    <div className={styles.bar} aria-busy={busy || undefined}>
      {back && <Link href="/practice" className={`${landing.back} ${styles.back}`}>{`← ${PRACTICE_COPY.backToPractice}`}</Link>}
      <Tabs
        tabs={PRACTICE_TABS.map((tab) => ({ id: tab, label: practiceTabLabel(tab, mode) }))}
        value={active}
        onChange={go}
        label={PRACTICE_COPY.tabsLabel}
        idBase={PRACTICE_TABS_ID}
        panelMounted={panelMounted}
        track={false}
        size="md"
      />
    </div>
  );
}
