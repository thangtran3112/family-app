"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { practiceBandText, replayBadgeText } from "@/lib/desk/freshness";
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
};

type PracticeChromeValue = {
  state: PracticeChromeState | null;
  setState: (state: PracticeChromeState | null) => void;
  /** The hub registers this so a click on a left-rail symbol fills the setup instead of leaving the page. */
  picker: { pick: (symbol: string) => void } | null;
  setPicker: (picker: { pick: (symbol: string) => void } | null) => void;
};

const Context = createContext<PracticeChromeValue | null>(null);

export function PracticeChromeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PracticeChromeState | null>(null);
  const [picker, setPicker] = useState<{ pick: (symbol: string) => void } | null>(null);
  const value = useMemo<PracticeChromeValue>(() => ({ state, setState, picker, setPicker }), [state, picker]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useValue(): PracticeChromeValue {
  const value = useContext(Context);
  if (!value) throw new Error("Practice chrome must be used inside the desktop shell");
  return value;
}

export const usePracticeChrome = (): PracticeChromeState | null => useValue().state;

/** The top-bar badge text during a replay, or null when the normal freshness badge applies. */
export function useReplayBadge(): string | null {
  const state = usePracticeChrome();
  return state?.day && state.playhead ? replayBadgeText(state.day, state.playhead, state.hidden) : null;
}

/** A Practice screen reports its day and playhead; the shell clears it when the screen unmounts. */
export function useReportPracticeChrome(next: PracticeChromeState | null): void {
  const { setState } = useValue();
  const day = next?.day ?? null;
  const hidden = next?.hidden ?? false;
  const playhead = next?.playhead ?? null;
  const present = next !== null;
  useEffect(() => {
    setState(present ? { day, hidden, playhead } : null);
  }, [setState, present, day, hidden, playhead]);
  useEffect(() => () => setState(null), [setState]);
}

/** The hub registers its symbol handler while mounted. */
export function useRegisterSymbolPicker(pick: (symbol: string) => void): void {
  const { setPicker } = useValue();
  const latest = useRef(pick);
  useEffect(() => {
    latest.current = pick;
  });
  useEffect(() => {
    const picker = { pick: (symbol: string) => latest.current(symbol) };
    setPicker(picker);
    return () => setPicker(null);
  }, [setPicker]);
}

/** The left-rail watchlist panel asks: `null` means a symbol click navigates as usual. */
export const useSymbolPicker = (): ((symbol: string) => void) | null => useValue().picker?.pick ?? null;

/** The 28 px band under the top bar on every Practice page. */
export function PracticeBand() {
  const state = usePracticeChrome();
  return (
    <div className={styles.band} role="status" aria-label="Practice">
      {practiceBandText(state?.day ?? null, state?.hidden ?? false)}
    </div>
  );
}
