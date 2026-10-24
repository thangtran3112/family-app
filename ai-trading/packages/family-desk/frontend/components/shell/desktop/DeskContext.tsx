"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { DeskStatus } from "@/lib/api/schemas";
import { loadStatus } from "@/lib/desk/status";
import type { Connection } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { readLanePreference, writeLanePreference, type Lane } from "@/lib/lanes";

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
  setSelectedListId: (id: number) => void;
  leftCollapsed: boolean;
  setLeftCollapsed: (collapsed: boolean) => void;
  /** The left rail's lists, bumped by `invalidate` when a screen creates, renames or deletes one. */
  revisions: { watchlists: number; filters: number };
  invalidate: (kind: "watchlists" | "filters") => void;
};

const UiContext = createContext<DeskUiValue | null>(null);

export function DeskUiProvider({ children }: { children: ReactNode }) {
  // The desktop shell only mounts on the client (after the viewport check), so localStorage is safe here.
  const [lane, setLaneState] = useState<Lane>(() => readLanePreference(window.localStorage));
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [revisions, setRevisions] = useState({ watchlists: 0, filters: 0 });
  const invalidate = useCallback((kind: "watchlists" | "filters") => setRevisions((current) => ({ ...current, [kind]: current[kind] + 1 })), []);
  const setLane = useCallback((next: Lane) => {
    writeLanePreference(window.localStorage, next);
    setLaneState(next);
  }, []);
  const rememberLane = useCallback((next: Lane) => writeLanePreference(window.localStorage, next), []);
  const value = useMemo<DeskUiValue>(
    () => ({ lane, setLane, rememberLane, selectedListId, setSelectedListId, leftCollapsed, setLeftCollapsed, revisions, invalidate }),
    [lane, setLane, rememberLane, selectedListId, leftCollapsed, revisions, invalidate],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useDeskUi(): DeskUiValue {
  const value = useContext(UiContext);
  if (!value) throw new Error("useDeskUi must be used inside the desktop shell");
  return value;
}

/** The element a page portals its right-rail content into (see RightRail). Null before mount. */
export const RailSlotContext = createContext<HTMLElement | null>(null);
