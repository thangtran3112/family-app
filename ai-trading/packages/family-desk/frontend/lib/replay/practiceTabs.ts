import { PRACTICE_COPY } from "../desk/freshness.ts";

// The tab strip of a practice thread: Summary and Portfolio are two views of /practice/thread (state in `?tab=`), the other
// two are routes that wear the same strip. Every target is a fixed URL of the thread: a freestyle thread has one Screen and one
// journal, so no tab asks the server where it goes (ADR-0025). There is no Order tab: a practice order is placed on the chart, which
// opens from a name on the Screen or the Portfolio.

export const PRACTICE_TABS = ["summary", "portfolio", "screen", "journal"] as const;
export type PracticeTab = (typeof PRACTICE_TABS)[number];
/** The two tabs that live on the thread page itself. */
export type ThreadPageTab = Extract<PracticeTab, "summary" | "portfolio">;

/** `?tab=` of the thread page. Missing or unknown is Summary, so `/practice/thread?id=12` stays the Summary URL. */
export const parseThreadTab = (raw: string | null): ThreadPageTab => (raw === "portfolio" ? "portfolio" : "summary");

export const threadPageHref = (threadId: number, tab: ThreadPageTab = "summary"): string =>
  tab === "summary" ? `/practice/thread?id=${threadId}` : `/practice/thread?id=${threadId}&tab=${tab}`;

/** The thread's Screen (the scan of her filters at the thread's time, her stars, the names she holds). */
export const screenHref = (threadId: number): string => `/practice/screen?thread=${threadId}`;

/** The thread's journal: its trades by ET date, its balance curve and its fills. */
export const journalHref = (threadId: number): string => `/practice/journal?thread=${threadId}`;

/** A lane's chart: one name of the thread, at the thread's time. */
export const replayHref = (sessionId: number): string => `/practice/replay?id=${sessionId}`;

export const practiceTabLabel = (tab: PracticeTab): string => {
  switch (tab) {
    case "summary": return PRACTICE_COPY.tabSummary;
    case "portfolio": return PRACTICE_COPY.tabPortfolio;
    case "screen": return PRACTICE_COPY.tabScreen;
    case "journal": return PRACTICE_COPY.tabJournal;
  }
};

/** Where a tab goes. Every target is fixed, so the strip navigates at once. */
export function tabHref(threadId: number, tab: PracticeTab): string {
  switch (tab) {
    case "summary":
    case "portfolio": return threadPageHref(threadId, tab);
    case "screen": return screenHref(threadId);
    case "journal": return journalHref(threadId);
  }
}
