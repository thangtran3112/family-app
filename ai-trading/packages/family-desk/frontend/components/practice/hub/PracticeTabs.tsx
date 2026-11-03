"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BackLink } from "@/components/practice/hub/BackLink";
import { Tabs } from "@/components/ui/Tabs";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { PRACTICE_TABS, practiceTabLabel, tabHref, type PracticeTab } from "@/lib/replay/practiceTabs";
import landing from "./landing.module.css";
import styles from "./PracticeTabs.module.css";

/** `idBase` of the strip: the thread page's `TabPanel` uses the same one. */
export const PRACTICE_TABS_ID = "practice-tabs";

/**
 * The strip of one practice thread: Summary, Portfolio, Screen, Trades. It stands in the row the "Back to practice" link used to take,
 * on the thread page, the Screen, the replay workspace and the Trades screen. The replay chart is where orders are placed, so no tab is
 * selected there. Every tab is a fixed URL of the thread (`tabHref`), so a click navigates at once. A lane with no thread has no strip and
 * keeps the plain back link. Summary and Portfolio share the thread page, which wraps its content in a `TabPanel` and passes
 * `panelMounted`; on the other screens the tabs are navigation and name no panel.
 */
export function PracticeTabs({
  threadId,
  active,
  back = true,
  panelMounted = false,
}: {
  threadId: number | null;
  /** The tab this screen is; null on the chart, which is a screen of the thread but no tab of it. */
  active: PracticeTab | null;
  /** The thread page already shows its own back link in its header. */
  back?: boolean;
  panelMounted?: boolean;
}) {
  const router = useRouter();
  if (threadId === null) return <BackLink threadId={null} />;

  function go(tab: PracticeTab) {
    if (tab === active || threadId === null) return;
    router.push(tabHref(threadId, tab), { scroll: false });
  }

  return (
    <div className={styles.bar}>
      {back && <Link href="/practice" className={`${landing.back} ${styles.back}`}>{`← ${PRACTICE_COPY.backToPractice}`}</Link>}
      <Tabs
        tabs={PRACTICE_TABS.map((tab) => ({ id: tab, label: practiceTabLabel(tab) }))}
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
