"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadReplayFeed } from "../desk/replay.ts";
import { chartBars, viewFromFeed } from "./feedState.ts";
import type { ReplayBar } from "./schemas.ts";
import type { MinuteBars } from "./sessionVwap.ts";
import { ms } from "./time.ts";

// The one-minute bars behind a 5m or 15m chart, for the session VWAP (D-168). The chart's own feed is read at the chart's interval, so a coarser
// chart has no minute bars: this reads the same session's feed at 1m (what the server has revealed so far, never ahead of it) and reads it again
// each time the playhead enters a new minute, at most once per MIN_GAP_MS. Nothing here moves the playhead.
// ponytail: each read brings the whole lookback again. A 1m delta endpoint would send only the new bars; add it if the payload ever shows.

const MIN_GAP_MS = 4000;
const minuteOf = (iso: string): number => Math.floor(ms(iso) / 60_000);

/** `enabled` is off on a one-minute chart (its bars already are the minute bars) and on a daily view; `playhead` is the chart's revealed-through time. */
export function useMinuteBars(sessionId: number, enabled: boolean, playhead: string): MinuteBars {
  const [read, setRead] = useState<{ bars: ReplayBar[]; through: string } | null>(null);
  const [failures, setFailures] = useState(0);
  const lastTry = useRef(0);
  const stale = enabled && (read === null || minuteOf(read.through) < minuteOf(playhead));

  // Re-runs when an answer or a failure lands, not on every poll: a read in flight is never cancelled by the next tick.
  useEffect(() => {
    if (!stale) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lastTry.current = Date.now();
      loadReplayFeed(sessionId, { interval: "1m" }, { signal: controller.signal })
        .then((feed) => {
          setFailures(0);
          setRead({ bars: chartBars(viewFromFeed(feed, "1m")), through: feed.revealed_through });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailures((count) => count + 1);
        });
    }, Math.max(0, MIN_GAP_MS * 2 ** Math.min(failures, 4) - (Date.now() - lastTry.current))); // a failing read backs off: 4 s, 8 s ... 64 s
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [stale, sessionId, read, failures]);

  return useMemo<MinuteBars>(() => ({ bars: read?.bars ?? [], status: read !== null ? "ready" : failures > 0 ? "unavailable" : "loading" }), [read, failures]);
}
