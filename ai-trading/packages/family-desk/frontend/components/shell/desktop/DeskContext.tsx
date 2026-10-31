"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Holdings } from "@/lib/api/fundamentalSchemas";
import type { DeskStatus } from "@/lib/api/schemas";
import { loadHoldings } from "@/lib/desk/holdings";
import { DEFAULT_MASK_VALUES, readMaskValues } from "@/lib/desk/mask";
import { loadSettings } from "@/lib/desk/settings";
import { loadStatus } from "@/lib/desk/status";
import type { Connection } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { LANE_STORAGE_KEY, readLanePreference, writeLanePreference, type Lane } from "@/lib/lanes";
import { readDefaultView } from "@/lib/settings/schema";

// Shell-level state shared by the top bar, rails, status bar and every desktop screen (02m §a3.1):
// /status is read once here and polled every 30 s; screens read it with `useDeskStatus()`.

export type DeskStatusValue = {
  /** Null until the first answer; the old value stays while a refresh runs. */
  status: DeskStatus | null;
  /** First load failed and there is nothing to show. */
  failed: boolean;
  connection: Connection;
  refresh: () => void;
};

const StatusContext = createContext<DeskStatusValue | null>(null);

export function DeskStatusProvider({ children }: { children: ReactNode }) {
  const query = useDeskQuery("status", (signal) => loadStatus({ signal }), { intervalMs: 30_000 });
  const value = useMemo<DeskStatusValue>(
    () => ({ status: query.data, failed: query.data === null && query.error !== null, connection: query.connection, refresh: query.refresh }),
    [query.data, query.error, query.connection, query.refresh],
  );
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useDeskStatus(): DeskStatusValue {
  const value = useContext(StatusContext);
  if (!value) throw new Error("useDeskStatus must be used inside the desktop shell");
  return value;
}

export type DeskUiValue = {
  lane: Lane;
  setLane: (lane: Lane) => void;
  /** Remember the lane for the next visit without switching this screen (Settings > Default view). */
  rememberLane: (lane: Lane) => void;
  /** The watchlist the left rail and the dashboard are showing; null until the lists load. */
  selectedListId: number | null;
  setSelectedListId: (id: number | null) => void;
  /** The symbol the Fundamental rails describe (a holdings row, a covered-call holding, the open stock); null before one is picked. */
  selectedSymbol: string | null;
  setSelectedSymbol: (symbol: string | null) => void;
  /** Dollar amounts, share counts and contract counts show as ••••• (02n §b1). Hidden on every load unless Settings turned the default off. */
  maskValues: boolean;
  setMaskValues: (masked: boolean) => void;
  leftCollapsed: boolean;
  setLeftCollapsed: (collapsed: boolean) => void;
  /** The replay chart fills the window: the shell hides the top bar, the left rail and the status bar (`data-focus="chart"`). A view state, never a route. */
  chartFocus: boolean;
  setChartFocus: (focus: boolean) => void;
  /** The left rail's lists, bumped by `invalidate` when a screen creates, renames or deletes one. */
  revisions: { watchlists: number; filters: number };
  invalidate: (kind: "watchlists" | "filters") => void;
  /** A screen with unsaved edits sets this; shell navigation that stays in the page (search, alerts bell) then asks first. */
  setDirty: (dirty: boolean) => void;
  confirmLeave: () => boolean;
};

const UiContext = createContext<DeskUiValue | null>(null);

export function DeskUiProvider({ children }: { children: ReactNode }) {
  // The desktop shell only mounts on the client (after the viewport check), so localStorage is safe here.
  const [lane, setLaneState] = useState<Lane>(() => readLanePreference(window.localStorage));
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [maskValues, setMaskValuesState] = useState(DEFAULT_MASK_VALUES);
  // The saved settings set two starting points once: the default view (only when this browser has no lane of its own yet)
  // and the masking default. A toggle in the top bar after that wins until the next load.
  const settingsQuery = useDeskQuery("shell-settings", (signal) => loadSettings({ signal }));
  const touched = useRef({ lane: false, mask: false });
  const loadedSettings = settingsQuery.data?.settings ?? null;
  useEffect(() => {
    if (!loadedSettings) return;
    if (!touched.current.mask) setMaskValuesState(readMaskValues(loadedSettings));
    const hasOwnLane = window.localStorage.getItem(LANE_STORAGE_KEY) !== null;
    if (!touched.current.lane && !hasOwnLane) setLaneState(readDefaultView(loadedSettings));
  }, [loadedSettings]);
  const setMaskValues = useCallback((masked: boolean) => {
    touched.current.mask = true;
    setMaskValuesState(masked);
  }, []);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [chartFocus, setChartFocus] = useState(false);
  const [revisions, setRevisions] = useState({ watchlists: 0, filters: 0 });
  const invalidate = useCallback((kind: "watchlists" | "filters") => setRevisions((current) => ({ ...current, [kind]: current[kind] + 1 })), []);
  const setLane = useCallback((next: Lane) => {
    touched.current.lane = true;
    writeLanePreference(window.localStorage, next);
    setLaneState(next);
  }, []);
  const dirty = useRef(false);
  const setDirty = useCallback((flag: boolean) => {
    dirty.current = flag;
  }, []);
  const confirmLeave = useCallback(() => !dirty.current || window.confirm("You have unsaved changes. Leave this page?"), []);
  const rememberLane = useCallback((next: Lane) => writeLanePreference(window.localStorage, next), []);
  const value = useMemo<DeskUiValue>(
    () => ({ lane, setLane, rememberLane, selectedListId, setSelectedListId, selectedSymbol, setSelectedSymbol, maskValues, setMaskValues, leftCollapsed, setLeftCollapsed, chartFocus, setChartFocus, revisions, invalidate, setDirty, confirmLeave }),
    [lane, setLane, rememberLane, selectedListId, selectedSymbol, maskValues, setMaskValues, leftCollapsed, chartFocus, revisions, invalidate, setDirty, confirmLeave],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useDeskUi(): DeskUiValue {
  const value = useContext(UiContext);
  if (!value) throw new Error("useDeskUi must be used inside the desktop shell");
  return value;
}

/** The active lane, or Technical where there is no desktop shell (the mobile shell has no lanes). For shared pages that render in both. */
export function useActiveLane(): Lane {
  return useContext(UiContext)?.lane ?? "technical";
}

/** The element a page portals its right-rail content into (see RightRail). Null before mount. */
export const RailSlotContext = createContext<HTMLElement | null>(null);

/** The element a Practice screen (replay, day list, journal) portals its left panel into (see LeftRailPortal). Null on every other page. */
export const LeftSlotContext = createContext<HTMLElement | null>(null);

export type DeskHoldingsValue = {
  /** Null until the first answer (and always null in the Technical lane, which never asks). */
  holdings: Holdings | null;
  failed: boolean;
  loading: boolean;
  connection: Connection;
  refresh: () => void;
};

const HoldingsContext = createContext<DeskHoldingsValue | null>(null);

/** `/holdings` read once for the Fundamental lane's rails and screens (all accounts), refreshed every minute. */
export function DeskHoldingsProvider({ children }: { children: ReactNode }) {
  const { lane } = useDeskUi();
  const query = useDeskQuery("holdings", (signal) => loadHoldings(undefined, { signal }), { intervalMs: 60_000, enabled: lane === "fundamental" });
  const value = useMemo<DeskHoldingsValue>(
    () => ({ holdings: query.data, failed: query.data === null && query.error !== null, loading: query.loading, connection: query.connection, refresh: query.refresh }),
    [query.data, query.error, query.loading, query.connection, query.refresh],
  );
  return <HoldingsContext.Provider value={value}>{children}</HoldingsContext.Provider>;
}

export function useHoldings(): DeskHoldingsValue {
  const value = useContext(HoldingsContext);
  if (!value) throw new Error("useHoldings must be used inside the desktop shell");
  return value;
}
