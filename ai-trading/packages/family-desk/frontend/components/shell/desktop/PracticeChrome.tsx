"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { PRACTICE_COPY, practiceBandText, replayBadgeText } from "@/lib/desk/freshness";
import type { PracticeStatusLine } from "@/lib/replay/statusLine";
import styles from "./practiceChrome.module.css";

// What a Practice screen tells the shell (02o §a1): which day it replays and where the playhead is, so the 28 px
// amber band, the top-bar "Replay · …" badge and the status bar can say so. Kept in its own small context, apart
// from DeskUi, because the playhead moves every second and only these three readers should re-render for it.

export type PracticeChromeState = {
  /** The replayed day "YYYY-MM-DD"; null on the hub. */
  day: string | null;
  /** The date is masked (a hidden notable day). */
  hidden: boolean;
  /** `revealed_through`; null until a session loads. */
  playhead: string | null;
  /** The screen covers past days (day list, journal), not one hidden session: the band says "past days" (D-015). */
  scope?: "session" | "days";
  /** This route's own status bar text; absent keeps the shell's line. */
  status?: PracticeStatusLine | null;
  /** The viewer may reveal the masked date for this view only (the replay band's "Show date", D-023). */
  onShowDate?: (() => void) | null;
};

// The state and its setter are two contexts. A screen that reports (`useReportPracticeChrome`) only needs the setter, which never changes:
// if it read the state too, every report would re-render the whole screen again (D-172).
const StateContext = createContext<PracticeChromeState | null | undefined>(undefined);
const SetterContext = createContext<((state: PracticeChromeState | null) => void) | null>(null);

export function PracticeChromeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PracticeChromeState | null>(null);
  return (
    <SetterContext.Provider value={setState}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </SetterContext.Provider>
  );
}

function useSetter(): (state: PracticeChromeState | null) => void {
  const setState = useContext(SetterContext);
  if (!setState) throw new Error("Practice chrome must be used inside the desktop shell");
  return setState;
}

export function usePracticeChrome(): PracticeChromeState | null {
  const state = useContext(StateContext);
  if (state === undefined) throw new Error("Practice chrome must be used inside the desktop shell");
  return state;
}

/** The top-bar badge text during a replay, or null when the normal freshness badge applies. */
export function useReplayBadge(): string | null {
  const state = usePracticeChrome();
  return state?.day && state.playhead ? replayBadgeText(state.day, state.playhead, state.hidden) : null;
}

/**
 * A Practice screen reports its day and playhead; the shell clears it when the screen unmounts. The report is made in a layout effect, in the same
 * commit that drew the screen's own clock readout, so the status bar and the top-bar chip repaint with it, never one tick behind (D-172): a passive
 * effect ran only after the chart's own effects and the paint, and the screen's own re-render for the report doubled that.
 */
export function useReportPracticeChrome(next: PracticeChromeState | null): void {
  const setState = useSetter();
  const day = next?.day ?? null;
  const hidden = next?.hidden ?? false;
  const playhead = next?.playhead ?? null;
  const scope = next?.scope ?? "session";
  const present = next !== null;
  // The status line and the reveal handler are rebuilt on every render; only their content (not their identity) is a dependency.
  const statusKey = next?.status ? `${next.status.left.join("\u0000")}\u0001${next.status.right.join("\u0000")}` : null;
  const canReveal = Boolean(next?.onShowDate);
  const latest = useRef(next);
  useLayoutEffect(() => {
    latest.current = next;
  });
  useLayoutEffect(() => {
    const status = latest.current?.status ?? null;
    setState(present ? { day, hidden, playhead, scope, status, onShowDate: canReveal ? () => latest.current?.onShowDate?.() : null } : null);
    // `statusKey` stands for the status line's content.
  }, [setState, present, day, hidden, playhead, scope, statusKey, canReveal]);
  // A layout cleanup, like the report: when one Practice screen replaces another, its clear must run before the next screen's report.
  useLayoutEffect(() => () => setState(null), [setState]);
}

/** The 28 px band under the top bar on every Practice page. A hidden session says why, and offers to show the date (D-023). */
export function PracticeBand() {
  const state = usePracticeChrome();
  const hiddenSession = state?.hidden === true && state.scope !== "days";
  return (
    <div className={styles.band}>
      <span role="status" aria-label="Practice">{practiceBandText(state?.day ?? null, state?.hidden ?? false, state?.scope === "days")}</span>
      <span className={styles.bandNote}>
        <span>{hiddenSession ? PRACTICE_COPY.bandHiddenWhy : PRACTICE_COPY.bandMarks}</span>
        {hiddenSession && state.onShowDate && (
          <Button variant="primary" size="sm" onClick={state.onShowDate}>{PRACTICE_COPY.showDate}</Button>
        )}
      </span>
    </div>
  );
}
