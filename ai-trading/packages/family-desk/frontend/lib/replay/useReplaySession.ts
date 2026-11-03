"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeskApiError, READ_TIMEOUT_MS } from "../api/client.ts";
import { backoffMs } from "../desk/backoff.ts";
import { advanceReplay, cancelOrder, loadReplayFeed, loadReplaySession, placeMark, placeOrder, undoMark, type AdvanceTarget, type OrderBody, type TapeParams } from "../desk/replay.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { applyAdvance, syncTarget, viewFromFeed, type ReplayView } from "./feedState.ts";
import { markForAction, noteMark, stopMark, type MarkBuild, type MarkDraft } from "./markInput.ts";
import type { EntryOrExit } from "./keys.ts";
import { canUndoLast, lastMark } from "./marks.ts";
import { createRequestQueue } from "./requestQueue.ts";
import type { ReplayInterval, ReplaySession } from "./schemas.ts";
import type { TicketAction } from "./ticket.ts";
import { problemMessage } from "./setup.ts";
import { filterById, tapeQuery, type SizeFilterId } from "./tape.ts";
import { notUpdating } from "./stale.ts";
import { POLL_MS } from "./useThreadClock.ts";
import { ms } from "./time.ts";

// The Replay workspace's data hook for one LANE of a freestyle thread (ADR-0025): a lane is a chart of the thread's time. The clock lives on the
// server and is moved only at the thread (Play, Pause, speed, Jump, Next open on the Summary), never here: this hook has no transport. It loads the
// lane and everything revealed so far, then asks to be brought to the thread clock every POLL_MS (`sync`); exactly one request is in flight, and
// every request goes through `/replay/sessions/{id}/…`. The browser never moves time itself, never slices around it, and never calls /bars or /quotes.

export type Toast = { id: number; tone: "info" | "error"; text: string };

export type ReplaySessionApi = {
  session: ReplaySession | null;
  view: ReplayView | null;
  loading: boolean;
  loadError: boolean;
  /** The server does not know this lane (404): "not found", not a failed load, so no retry. */
  notFound: boolean;
  /** A request of hers (a mark, an order, a re-read) is in flight. */
  busy: boolean;
  /** The last request failed: the plain sentence, until the next one succeeds. The chart is dimmed while it stands. */
  error: string | null;
  toast: Toast | null;
  filterId: SizeFilterId;
  interval: ReplayInterval;
  reload: () => void;
  dismissToast: () => void;
  /** Pause a plain note's countdown while the pointer or focus is on it; `releaseToast` starts it again. An error never counts down. */
  holdToast: () => void;
  releaseToast: () => void;
  /** Shows a message in the toast slot (a key that is not possible now, for example). */
  notify: (tone: Toast["tone"], text: string) => void;
  /** Brings a lane that is behind the thread clock up to it (02o-b2). */
  catchUp: () => void;
  /** This lane follows its thread's server-side clock: it polls it, and the thread is active. A closed thread's lane is read as it was left. */
  follows: boolean;
  /** The lane is not being updated: two sync polls in a row failed, or no answer came for STALE_AFTER_MS. The readout is frozen and the chart dimmed (ADR-0022). */
  stale: boolean;
  /** Resolves true when the server accepted the mark. */
  mark: (kind: EntryOrExit, draft: MarkDraft) => Promise<boolean>;
  /** Sends what the order ticket built: a market entry mark, or a limit, stop or stop-limit order. Resolves true when accepted. `refused` hears the field the server named, so the message sits at that field. */
  ticket: (action: TicketAction, refused?: Refusal) => Promise<boolean>;
  /** Cancels a working order. */
  cancelOrder: (id: number) => void;
  /** Resolve true when the server took the stop or the note; the form stays open on a refusal. */
  stopNote: (price: string) => Promise<boolean>;
  note: (text: string) => Promise<boolean>;
  undo: () => void;
  setFilter: (id: SizeFilterId) => void;
  setInterval: (interval: ReplayInterval) => void;
};

/** A plain note clears itself after this long; an error stays until it is dismissed (WCAG 2.2.1: nothing she must read disappears on a timer). */
const DISMISS_MS = 4500;

/** Told why the ticket's order failed: the field the server named (`path`: shares, limitPrice, stopPrice, or "" when it named none) and the sentence. Returns true when the ticket now shows it. */
export type Refusal = (path: string, message: string) => boolean;
/** True when the ticket took the failure (at the field the server named, or on the ticket as a whole): it is then not said a second time in the message line. */
const refusedAt = (error: unknown, refused: Refusal | undefined, fallback: string): boolean => {
  if (refused === undefined) return false;
  const problem = error instanceof DeskApiError ? error.problems[0] : undefined;
  return refused(problem?.path ?? "", problemMessage(error, fallback));
};

export function useReplaySession(id: number | null): ReplaySessionApi {
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [view, setView] = useState<ReplayView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [filterId, setFilterId] = useState<SizeFilterId>("all");
  const [interval, setIntervalState] = useState<ReplayInterval>("5m");
  const [revision, setRevision] = useState(0);
  // The followed chart is not being updated (`notUpdating`); `lastAnswer` is when the server last answered this screen.
  const [stalled, setStalled] = useState(false);
  // Monotonic time (`performance.now`): a wall-clock change, or a test that fixes `Date`, must not stop the back-off or freeze the notice.
  // Set when the lane loads (the poll starts only after that); read in effects only, so render stays pure.
  const lastAnswer = useRef(0);

  // Refs mirror state for the timer and the queue, which outlive a render.
  const alive = useRef(true);
  const viewRef = useRef(view);
  const sessionRef = useRef(session);
  const filterRef = useRef(filterId);
  const intervalRef = useRef(interval);
  const pending = useRef(0);
  const [queue] = useState(createRequestQueue);
  const toastId = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTone = useRef<Toast["tone"]>("info");
  useEffect(() => {
    viewRef.current = view;
    sessionRef.current = session;
    filterRef.current = filterId;
    intervalRef.current = interval;
  });

  const say = useCallback((tone: Toast["tone"], text: string) => {
    toastId.current += 1;
    toastTone.current = tone;
    setToast({ id: toastId.current, tone, text });
    clearTimeout(toastTimer.current);
    toastTimer.current = tone === "error" ? undefined : setTimeout(() => setToast(null), DISMISS_MS);
  }, []);
  const dismissToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    setToast(null);
  }, []);
  const holdToast = useCallback(() => clearTimeout(toastTimer.current), []);
  const releaseToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    if (toastTone.current === "info") toastTimer.current = setTimeout(() => setToast(null), DISMISS_MS);
  }, []);

  const tape = useCallback((): TapeParams => {
    const query = tapeQuery(filterById(filterRef.current), viewRef.current?.tapeMeta?.bigPrintUsd ?? null);
    return { interval: intervalRef.current, minSize: query.minSize, minNotional: query.minNotional };
  }, []);

  // Load the lane, then everything revealed so far (resume restores the playhead, the bars and the tape).
  useEffect(() => {
    alive.current = true;
    if (id === null) return;
    const controller = new AbortController();
    (async () => {
      try {
        const loaded = await loadReplaySession(id, { signal: controller.signal });
        const feed = await loadReplayFeed(id, { interval: loaded.spec.interval }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        let shown = viewFromFeed(feed, loaded.spec.interval);
        if (loaded.thread_id !== null && loaded.status === "active" && loaded.thread?.status !== "closed") {
          // The thread clock runs on the server (ADR-0018): `sync` brings it to now and reveals this name through it, so a chart opened at any moment
          // shows the market as it is at that moment, also when the name was last opened before a Jump. A sync that hangs must not hold the whole screen
          // on its skeleton: the lane is shown as the feed has it, and the poll below catches up.
          const delta = await advanceReplay(id, { sync: true }, { interval: loaded.spec.interval }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) }).catch(() => null);
          if (controller.signal.aborted) return;
          if (delta) shown = applyAdvance(shown, delta);
        }
        lastAnswer.current = performance.now();
        // The lane's first paint is a transition: React renders the whole workspace in slices of a few milliseconds with the browser free between them, not as one
        // task of 60 ms or more on a slow machine (D-240). The polls that follow stay plain updates, which the chart's per-bar work (D-217) relies on.
        startTransition(() => {
          setStalled(false);
          setSession(loaded);
          setIntervalState(loaded.spec.interval);
          setView(shown);
          setError(null);
        });
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof DeskApiError && failure.status === 404) setNotFound(true);
        else setLoadError(true);
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
      clearTimeout(toastTimer.current);
    };
  }, [id, revision]);

  /** Runs `task` after every earlier request of this lane, counted as the one request in flight. Resolves with its result. */
  const exec = useCallback(
    <T,>(task: () => Promise<T>): Promise<T | null> => {
      pending.current += 1;
      setBusy(true);
      return queue
        .run(async () => {
          if (!alive.current) return null;
          try {
            return await task();
          } catch {
            // Every task answers its own failures; this keeps a surprise from leaving the lane stuck "busy".
            setError(PRACTICE_COPY.advanceError);
            return null;
          }
        })
        .finally(() => {
          pending.current -= 1;
          if (alive.current && pending.current === 0) setBusy(false);
        });
    },
    [queue],
  );

  /** After the tape filled an order: the journal, the thread's balance and the marks are read again. */
  const refreshBook = useCallback(async () => {
    if (id === null) return;
    try {
      const fresh = await loadReplaySession(id);
      if (alive.current) setSession((current) => (current ? { ...current, journal: fresh.journal, thread: fresh.thread ?? current.thread, marks: fresh.marks, orders: fresh.orders } : current));
    } catch {
      // The next advance carries the orders again; a failed read here is not worth a message.
    }
  }, [id]);

  /** Reveals what the thread clock has passed. Failures: a 422 is a message; a follow poll (`quiet`) that failed is tried again by the next one. */
  const advance = useCallback(
    async (target: AdvanceTarget, quiet = false): Promise<boolean> => {
      if (id === null) return false;
      try {
        // A follow poll (`quiet`) gives up after the read timeout: a request that hangs must not hold the screen busy for good.
        const delta = await advanceReplay(id, target, tape(), quiet ? { signal: AbortSignal.timeout(READ_TIMEOUT_MS) } : undefined);
        if (!alive.current) return false;
        setView((current) => (current ? applyAdvance(current, delta) : current));
        lastAnswer.current = performance.now();
        setStalled(false);
        setError(null);
        if (delta.fills?.length) {
          // The tape filled working orders inside this advance: the entry marks, the orders' new state and the book behind them.
          const filled = delta.fills.map((fill) => fill.price).filter((price): price is number => price !== null);
          say("info", practiceText("orderFilled", { price: filled.map((price) => price.toFixed(2)).join(" · ") }));
          setSession((current) => (current ? { ...current, marks: [...current.marks, ...delta.fills!.filter((fill) => !current.marks.some((mark) => mark.id === fill.id))], orders: delta.orders, open_trade: delta.open_trade } : current));
          await refreshBook();
        } else if (delta.orders.length > 0) {
          setSession((current) => (current ? { ...current, orders: delta.orders } : current));
        }
        return true;
      } catch (failure) {
        if (!alive.current) return false;
        if (quiet) return false; // a follow poll that failed: the next one tries again, nothing is dimmed or said
        if (failure instanceof DeskApiError && failure.status === 422) say("info", problemMessage(failure, PRACTICE_COPY.advanceError));
        else setError(PRACTICE_COPY.advanceError);
        return false;
      }
    },
    [id, say, tape, refreshBook],
  );

  // A lane of an active thread follows the thread's clock, which runs on the server whether or not this screen is open (ADR-0018). Every
  // POLL_MS the screen asks to be brought to it; `sync` settles the clock first, so the answer is the market as it is now. There is no
  // Play here: leaving this screen and coming back finds the clock where the server has it, and the load above syncs once.
  const threadId = session?.thread_id ?? null;
  const follows = session !== null && threadId !== null && session.status === "active" && session.thread?.status !== "closed";
  const syncing = useRef(false);
  // Failed polls in a row and when the last one failed: while the server does not answer, the poll waits twice as long after each failure.
  const syncFailed = useRef({ count: 0, at: 0 });
  useEffect(() => {
    if (!follows) return;
    syncFailed.current = { count: 0, at: 0 };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // No answer for ten seconds while the tab is in view: the screen says so (a poll that is only waiting out its back-off counts too). A request of her own
      // in flight (a re-read at another interval, an order) is the server working for her, not silence.
      if (!(pending.current > 0 && !syncing.current) && notUpdating(0, performance.now() - lastAnswer.current)) setStalled(true);
      if (syncing.current || pending.current > 0) return;
      const failed = syncFailed.current;
      if (failed.count > 0 && performance.now() - failed.at < backoffMs(POLL_MS, failed.count)) return;
      syncing.current = true;
      void exec(() => advance(syncTarget(viewRef.current), true))
        .then((ok) => {
          if (ok === true) syncFailed.current = { count: 0, at: 0 };
          else if (ok === false) {
            syncFailed.current = { count: failed.count + 1, at: performance.now() };
            if (notUpdating(failed.count + 1, 0)) setStalled(true);
          }
        })
        .finally(() => {
          syncing.current = false;
        });
    }, POLL_MS);
    // A tab that was in the background did not poll: it is not "not updating", it was not asked. The count starts again when it is shown.
    const onVisible = () => {
      if (document.visibilityState === "visible") lastAnswer.current = performance.now();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [follows, exec, advance]);

  const catchUp = useCallback(() => {
    if (follows) void exec(() => advance({ sync: true }));
  }, [follows, exec, advance]);

  /** Sends a built mark; the server stamps it at the thread's time and answers the new book. */
  const send = useCallback(
    async (built: MarkBuild, refused?: Refusal): Promise<boolean> => {
      if (id === null) return false;
      if (!built.ok) {
        say("error", built.message);
        return false;
      }
      const accepted = await exec(async () => {
        try {
          const result = await placeMark(id, built.mark);
          if (!alive.current) return false;
          setSession((current) => (current ? { ...current, marks: [...current.marks, result.mark], open_trade: result.open_trade, journal: result.journal, thread: result.thread ?? current.thread } : current));
          setView((current) => (current ? { ...current, openTrade: result.open_trade } : current));
          if (result.warning) say("info", result.warning); // priced off an old print: the price is accepted, the warning says so
          return true;
        } catch (failure) {
          if (!alive.current) return false;
          if (!refusedAt(failure, refused, PRACTICE_COPY.orderError)) say("error", problemMessage(failure, PRACTICE_COPY.orderError));
          return false;
        }
      });
      return accepted === true;
    },
    [id, exec, say],
  );
  const mark = useCallback((kind: EntryOrExit, draft: MarkDraft) => send(markForAction(kind, draft)), [send]);

  /** Places a limit, stop or stop-limit order; the server answers the order, the list, and the entry mark when it filled at once. */
  const submitOrder = useCallback(
    async (body: OrderBody, refused?: Refusal): Promise<boolean> => {
      if (id === null) return false;
      const accepted = await exec(async () => {
        try {
          const result = await placeOrder(id, body);
          if (!alive.current) return false;
          setSession((current) =>
            current
              ? { ...current, marks: result.mark ? [...current.marks, result.mark] : current.marks, orders: result.orders, open_trade: result.open_trade, journal: result.journal, thread: result.thread ?? current.thread }
              : current,
          );
          setView((current) => (current ? { ...current, openTrade: result.open_trade } : current));
          if (result.warning) say("info", result.warning);
          return true;
        } catch (failure) {
          if (!alive.current) return false;
          if (!refusedAt(failure, refused, PRACTICE_COPY.orderError)) say("error", problemMessage(failure, PRACTICE_COPY.orderError));
          return false;
        }
      });
      return accepted === true;
    },
    [id, exec, say],
  );
  const ticket = useCallback((action: TicketAction, refused?: Refusal) => (action.kind === "mark" ? send({ ok: true, mark: action.mark }, refused) : submitOrder(action.order, refused)), [send, submitOrder]);

  const cancel = useCallback(
    (orderId: number) => {
      if (id === null) return;
      void exec(async () => {
        try {
          const result = await cancelOrder(id, orderId);
          if (!alive.current) return;
          setSession((current) => (current ? { ...current, orders: result.orders } : current));
        } catch (failure) {
          if (!alive.current) return;
          say("error", problemMessage(failure, PRACTICE_COPY.cancelError));
        }
      });
    },
    [id, exec, say],
  );
  const stopNote = useCallback((price: string) => send(stopMark(price)), [send]);
  const note = useCallback((text: string) => send(noteMark(text)), [send]);

  const undo = useCallback(() => {
    if (id === null) return;
    const current = sessionRef.current;
    const head = viewRef.current;
    const last = current ? lastMark(current.marks) : null;
    if (!current || !head || !last) {
      say("info", PRACTICE_COPY.nothingToUndo);
      return;
    }
    // Undo corrects a mistake, it is not time travel: it is allowed only while the clock has not moved since the mark.
    if (!canUndoLast(current.marks, head.revealedThrough)) {
      say("info", PRACTICE_COPY.undoTooLate);
      return;
    }
    void exec(async () => {
      try {
        const result = await undoMark(id, last.id);
        if (!alive.current) return;
        setSession((now) =>
          now ? { ...now, marks: now.marks.filter((item) => item.id !== last.id), open_trade: result.open_trade, journal: result.journal, thread: result.thread ?? now.thread } : now,
        );
        setView((now) => (now ? { ...now, openTrade: result.open_trade } : now));
        say("info", PRACTICE_COPY.undone);
      } catch (failure) {
        if (!alive.current) return;
        say("error", problemMessage(failure, failure instanceof DeskApiError && failure.status === 409 ? PRACTICE_COPY.undoTooLate : PRACTICE_COPY.orderError));
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
          lastAnswer.current = performance.now();
          setStalled(false);
          setError(null);
          setView((current) => {
            const fresh = viewFromFeed(feed, nextInterval);
            // Never let a re-read move the playhead back.
            return current && ms(current.revealedThrough) > ms(fresh.revealedThrough) ? current : fresh;
          });
        } catch {
          if (alive.current) setError(PRACTICE_COPY.advanceError);
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
      session, view, loading: id !== null && !loadError && !notFound && (session === null || view === null), loadError, notFound, busy, error, toast, filterId, interval,
      reload, dismissToast, holdToast, releaseToast, notify: say, catchUp, follows, stale: follows && stalled, mark, ticket, cancelOrder: cancel, stopNote, note, undo, setFilter, setInterval,
    }),
    [session, view, id, loadError, notFound, busy, error, toast, filterId, interval, reload, dismissToast, holdToast, releaseToast, say, catchUp, follows, stalled, mark, ticket, cancel, stopNote, note, undo, setFilter, setInterval],
  );
}
