"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DeskApiError } from "../api/client.ts";
import { advanceReplay, endReplay, loadReplayFeed, loadReplaySession, placeMark, undoMark, type AdvanceTarget, type TapeParams } from "../desk/replay.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import { delayUntilNextTick, isSpeed, jumpMinutes, nextTo, type Speed } from "./clock.ts";
import { applyAdvance, viewFromFeed, type ReplayView } from "./feedState.ts";
import { markForAction, noteMark, stopMark, type MarkBuild, type MarkDraft } from "./markInput.ts";
import type { EntryOrExit } from "./keys.ts";
import { canUndoLast, lastMark } from "./marks.ts";
import { canRequest, initialPlayer, playerReducer } from "./player.ts";
import type { ReplayInterval, ReplaySession } from "./schemas.ts";
import { problemMessage } from "./setup.ts";
import { filterById, tapeQuery, type SizeFilterId } from "./tape.ts";
import { etWallToUtcIso, ms } from "./time.ts";

// The Replay workspace's data hook (02o §d `useReplayPlayer`): idle -> playing <-> paused -> at_end, any error to
// paused, exactly one request in flight. Every request goes through `/replay/sessions/{id}/…`; the browser never moves
// the playhead itself, never slices around it, and never calls /bars or /quotes.

export type Toast = { id: number; tone: "info" | "error"; text: string };

export type ReplaySessionApi = {
  session: ReplaySession | null;
  view: ReplayView | null;
  loading: boolean;
  loadError: boolean;
  player: ReturnType<typeof initialPlayer>;
  toast: Toast | null;
  filterId: SizeFilterId;
  interval: ReplayInterval;
  /** The live open trade, fresher than `session.open_trade`. */
  reload: () => void;
  dismissToast: () => void;
  /** Shows a message in the toast slot (a key that is not possible now, for example). */
  notify: (tone: Toast["tone"], text: string) => void;
  togglePlay: () => void;
  setSpeed: (speed: Speed) => void;
  step: () => void;
  nextSignal: () => void;
  jumpBy: (minutes: number) => void;
  jumpToTime: (hhmm: string) => void;
  jumpToEnd: () => void;
  /** Resolves true when the server accepted the mark. */
  mark: (kind: EntryOrExit, draft: MarkDraft) => Promise<boolean>;
  stopNote: (price: string) => void;
  note: (text: string) => void;
  undo: () => void;
  end: () => Promise<ReplaySession | null>;
  setFilter: (id: SizeFilterId) => void;
  setInterval: (interval: ReplayInterval) => void;
};

const DISMISS_MS = 4500;

export function useReplaySession(id: number | null): ReplaySessionApi {
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [view, setView] = useState<ReplayView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [player, dispatch] = useReducer(playerReducer, undefined, () => initialPlayer());
  const [toast, setToast] = useState<Toast | null>(null);
  const [filterId, setFilterId] = useState<SizeFilterId>("all");
  const [interval, setIntervalState] = useState<ReplayInterval>("5m");
  const [revision, setRevision] = useState(0);

  // Refs mirror state for the timer and the queue, which outlive a render.
  const alive = useRef(true);
  const playerRef = useRef(player);
  const viewRef = useRef(view);
  const sessionRef = useRef(session);
  const filterRef = useRef(filterId);
  const intervalRef = useRef(interval);
  const busy = useRef(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const lastStart = useRef(0);
  const toastId = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    playerRef.current = player;
    viewRef.current = view;
    sessionRef.current = session;
    filterRef.current = filterId;
    intervalRef.current = interval;
  });

  const say = useCallback((tone: Toast["tone"], text: string) => {
    toastId.current += 1;
    setToast({ id: toastId.current, tone, text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), DISMISS_MS);
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const tape = useCallback((): TapeParams => {
    const query = tapeQuery(filterById(filterRef.current), viewRef.current?.tapeMeta?.bigPrintUsd ?? null);
    return { interval: intervalRef.current, minSize: query.minSize, minNotional: query.minNotional };
  }, []);

  // Load the session, then everything revealed so far (resume restores the playhead, the bars and the tape).
  useEffect(() => {
    alive.current = true;
    if (id === null) return;
    const controller = new AbortController();
    (async () => {
      try {
        const loaded = await loadReplaySession(id, { signal: controller.signal });
        const feed = await loadReplayFeed(id, { interval: loaded.spec.interval }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSession(loaded);
        setIntervalState(loaded.spec.interval);
        setView(viewFromFeed(feed, loaded.spec.interval));
        dispatch({ type: "loaded", atEnd: feed.at_end || loaded.status === "ended" });
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
      clearTimeout(toastTimer.current);
    };
  }, [id, revision]);

  /** Runs `task` after every earlier user action, counted as the one request in flight. Resolves with its result. */
  const exec = useCallback(<T,>(task: () => Promise<T>): Promise<T | null> => {
    const run = chain.current.then(async () => {
      if (!alive.current) return null;
      busy.current = true;
      dispatch({ type: "request" });
      try {
        return await task();
      } catch {
        // Every task answers its own failures; this keeps a surprise from leaving the player stuck "busy".
        dispatch({ type: "failed", message: PRACTICE_COPY.advanceError });
        return null;
      } finally {
        busy.current = false;
      }
    });
    chain.current = run.catch(() => undefined);
    return run.catch(() => null);
  }, []);

  /** Moves the playhead. Failures: a 422 (for example no more signals) is a message; anything else stops playback. */
  const advance = useCallback(
    async (target: AdvanceTarget): Promise<boolean> => {
      if (id === null) return false;
      try {
        const delta = await advanceReplay(id, target, tape());
        if (!alive.current) return false;
        setView((current) => (current ? applyAdvance(current, delta) : current));
        dispatch({ type: "settled", atEnd: delta.at_end });
        return true;
      } catch (error) {
        if (!alive.current) return false;
        if (error instanceof DeskApiError && error.status === 422) {
          dispatch({ type: "settled", atEnd: false });
          say("info", problemMessage(error, PRACTICE_COPY.advanceError));
        } else {
          dispatch({ type: "failed", message: PRACTICE_COPY.advanceError });
        }
        return false;
      }
    },
    [id, say, tape],
  );

  // Play: one request per wall-clock second, started only when none is in flight, so a slow answer stutters the
  // tape instead of letting the clock run ahead of the server.
  const { status: playStatus, busy: playBusy, speed } = player;
  const revealed = view?.revealedThrough ?? null;
  useEffect(() => {
    if (playStatus !== "playing" || playBusy || !session || revealed === null) return;
    const timer = setTimeout(() => {
      if (!canRequest(playerRef.current) || busy.current || playerRef.current.status !== "playing") return;
      const current = viewRef.current;
      const target = sessionRef.current;
      if (!current || !target) return;
      lastStart.current = Date.now();
      void exec(() => advance({ to: nextTo(current.revealedThrough, playerRef.current.speed, target.window_end) }));
    }, delayUntilNextTick(lastStart.current, Date.now()));
    return () => clearTimeout(timer);
  }, [playStatus, playBusy, revealed, speed, session, exec, advance]);

  /** Step, jump and next-signal work while paused or playing; not while loading or after the window end. */
  const guard = () => playerRef.current.status === "paused" || playerRef.current.status === "playing";

  const togglePlay = useCallback(() => dispatch({ type: "toggle" }), []);
  const setSpeed = useCallback((next: Speed) => {
    if (isSpeed(next)) dispatch({ type: "speed", speed: next });
  }, []);
  const step = useCallback(() => {
    if (guard()) void exec(() => advance({ step: "bar" }));
  }, [exec, advance]);
  const nextSignal = useCallback(() => {
    if (guard()) void exec(() => advance({ step: "next_signal" }));
  }, [exec, advance]);
  const jumpBy = useCallback(
    (minutes: number) => {
      const current = viewRef.current;
      const target = sessionRef.current;
      if (current && target && guard()) void exec(() => advance({ to: jumpMinutes(current.revealedThrough, minutes, target.window_end) }));
    },
    [exec, advance],
  );
  const jumpToTime = useCallback(
    (hhmm: string) => {
      const target = sessionRef.current;
      const to = target ? etWallToUtcIso(target.spec.day, hhmm) : null;
      if (!target || to === null || !guard()) return;
      void exec(() => advance({ to }));
    },
    [exec, advance],
  );
  const jumpToEnd = useCallback(() => {
    const target = sessionRef.current;
    if (target && guard()) void exec(() => advance({ to: target.window_end }));
  }, [exec, advance]);

  /** Sends a built mark; the server stamps it at the playhead and answers the new book. */
  const send = useCallback(
    async (built: MarkBuild): Promise<boolean> => {
      if (id === null) return false;
      if (!built.ok) {
        say("error", built.message);
        return false;
      }
      const accepted = await exec(async () => {
        try {
          const result = await placeMark(id, built.mark);
          if (!alive.current) return false;
          setSession((current) => (current ? { ...current, marks: [...current.marks, result.mark], open_trade: result.open_trade, journal: result.journal } : current));
          setView((current) => (current ? { ...current, openTrade: result.open_trade } : current));
          dispatch({ type: "settled", atEnd: playerRef.current.status === "at_end" });
          return true;
        } catch (error) {
          if (!alive.current) return false;
          dispatch({ type: "settled", atEnd: playerRef.current.status === "at_end" });
          say("error", problemMessage(error, PRACTICE_COPY.markError));
          return false;
        }
      });
      return accepted === true;
    },
    [id, exec, say],
  );
  const mark = useCallback((kind: EntryOrExit, draft: MarkDraft) => send(markForAction(kind, draft)), [send]);
  const stopNote = useCallback((price: string) => void send(stopMark(price)), [send]);
  const note = useCallback((text: string) => void send(noteMark(text)), [send]);

  const undo = useCallback(() => {
    if (id === null) return;
    const current = sessionRef.current;
    const head = viewRef.current;
    const last = current ? lastMark(current.marks) : null;
    if (!current || !head || !last) {
      say("info", PRACTICE_COPY.nothingToUndo);
      return;
    }
    if (!canUndoLast(current.marks, head.revealedThrough)) {
      say("info", PRACTICE_COPY.undoTooLate);
      return;
    }
    void exec(async () => {
      try {
        const result = await undoMark(id, last.id);
        if (!alive.current) return;
        // The server's answer carries the new book; without one, the session is read again.
        const fresh = result?.journal ? null : await loadReplaySession(id);
        setSession((now) => {
          const base = fresh ?? now;
          if (!base) return now;
          return {
            ...base,
            marks: base.marks.filter((item) => item.id !== last.id),
            open_trade: result ? result.open_trade : base.open_trade,
            journal: result?.journal ?? base.journal,
          };
        });
        setView((now) => (now && result ? { ...now, openTrade: result.open_trade } : now));
        dispatch({ type: "settled", atEnd: playerRef.current.status === "at_end" });
        say("info", PRACTICE_COPY.undone);
      } catch (error) {
        if (!alive.current) return;
        dispatch({ type: "settled", atEnd: playerRef.current.status === "at_end" });
        say("error", problemMessage(error, error instanceof DeskApiError && error.status === 409 ? PRACTICE_COPY.undoTooLate : PRACTICE_COPY.markError));
      }
    });
  }, [id, exec, say]);

  const end = useCallback(async (): Promise<ReplaySession | null> => {
    if (id === null) return null;
    return exec(async () => {
      try {
        const ended = await endReplay(id);
        if (alive.current) {
          setSession(ended);
          dispatch({ type: "settled", atEnd: true });
        }
        return ended;
      } catch (error) {
        if (alive.current) {
          dispatch({ type: "settled", atEnd: playerRef.current.status === "at_end" });
          say("error", problemMessage(error, PRACTICE_COPY.markError));
        }
        return null;
      }
    });
  }, [id, exec, say]);

  /** Re-reads the revealed history at a new interval or tape filter; the playhead stays where it is. */
  const reread = useCallback(
    (nextInterval: ReplayInterval, nextFilter: SizeFilterId) => {
      if (id === null) return;
      setIntervalState(nextInterval);
      setFilterId(nextFilter);
      intervalRef.current = nextInterval;
      filterRef.current = nextFilter;
      void exec(async () => {
        try {
          const feed = await loadReplayFeed(id, tape());
          if (!alive.current) return;
          setView((current) => {
            const fresh = viewFromFeed(feed, nextInterval);
            // Never let a re-read move the playhead back.
            return current && ms(current.revealedThrough) > ms(fresh.revealedThrough) ? current : fresh;
          });
          dispatch({ type: "settled", atEnd: playerRef.current.status === "at_end" });
        } catch {
          if (alive.current) dispatch({ type: "failed", message: PRACTICE_COPY.advanceError });
        }
      });
    },
    [id, exec, tape],
  );
  const setFilter = useCallback((next: SizeFilterId) => reread(intervalRef.current, next), [reread]);
  const setInterval = useCallback((next: ReplayInterval) => reread(next, filterRef.current), [reread]);

  const reload = useCallback(() => {
    setLoadError(false);
    setSession(null);
    setView(null);
    setRevision((value) => value + 1);
  }, []);

  return useMemo(
    () => ({
      session, view, loading: id !== null && !loadError && (session === null || view === null), loadError, player, toast, filterId, interval,
      reload, dismissToast, notify: say, togglePlay, setSpeed, step, nextSignal, jumpBy, jumpToTime, jumpToEnd, mark, stopNote, note, undo, end, setFilter, setInterval,
    }),
    [session, view, id, loadError, player, toast, filterId, interval, reload, dismissToast, say, togglePlay, setSpeed, step, nextSignal, jumpBy, jumpToTime, jumpToEnd, mark, stopNote, note, undo, end, setFilter, setInterval],
  );
}
