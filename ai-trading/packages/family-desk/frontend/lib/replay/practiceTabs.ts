import { PRACTICE_COPY } from "../desk/freshness.ts";

// The tab strip of a practice thread: Summary and Portfolio are two views of /practice/thread (state in `?tab=`), the other
// three are routes that wear the same strip. Every target is resolved from the server's open day, never from a client cache.

export const PRACTICE_TABS = ["summary", "portfolio", "day", "order", "journal"] as const;
export type PracticeTab = (typeof PRACTICE_TABS)[number];
/** The two tabs that live on the thread page itself. */
export type ThreadPageTab = Extract<PracticeTab, "summary" | "portfolio">;

/** `?tab=` of the thread page. Missing or unknown is Summary, so `/practice/thread?id=12` stays the Summary URL. */
export const parseThreadTab = (raw: string | null): ThreadPageTab => (raw === "portfolio" ? "portfolio" : "summary");

export const threadPageHref = (threadId: number, tab: ThreadPageTab = "summary"): string =>
  tab === "summary" ? `/practice/thread?id=${threadId}` : `/practice/thread?id=${threadId}&tab=${tab}`;

/** A swing thread's day screen is a board of names, not a list of candidates. */
export const practiceTabLabel = (tab: PracticeTab, mode: "day" | "swing"): string => {
  switch (tab) {
    case "summary": return PRACTICE_COPY.tabSummary;
    case "portfolio": return PRACTICE_COPY.tabPortfolio;
    case "day": return mode === "swing" ? PRACTICE_COPY.tabBoard : PRACTICE_COPY.tabDayList;
    case "order": return PRACTICE_COPY.tabOrder;
    case "journal": return PRACTICE_COPY.tabJournal;
  }
};

export type TabLoaders = {
  /** The thread's open day (`today`): null while no day is under way. */
  today: (threadId: number) => Promise<{ day_list_id: number } | null>;
};

/**
 * Where a tab goes right now. Summary, Portfolio, Order and Trades are fixed: Order is the thread's own "pick a stock" page, never
 * a chart of a stock she did not choose (a chart opens only from a name on the Day list or the Portfolio). Day list is the thread's
 * open day; with no day open it lands on Summary, whose one step starts the day.
 */
export async function resolveTabHref(threadId: number, tab: PracticeTab, load: TabLoaders): Promise<string> {
  if (tab === "summary" || tab === "portfolio") return threadPageHref(threadId, tab);
  if (tab === "order") return `/practice/order?thread=${threadId}`;
  if (tab === "journal") return `/practice/journal?thread=${threadId}`;
  const today = await load.today(threadId);
  return today === null ? threadPageHref(threadId) : `/practice/day?id=${today.day_list_id}`;
}
