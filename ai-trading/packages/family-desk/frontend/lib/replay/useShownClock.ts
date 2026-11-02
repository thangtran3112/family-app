"use client";

import { useEffect, useState } from "react";
import type { Speed } from "./clock.ts";
import { extrapolate } from "./threadClock.ts";

// The thread's time on a chart (ADR-0018, D-166): the server's clock, polled every POLL_MS, moved on every second by the wall time since the
// last answer. The readout, the status bar's "Replay clock" and the top-bar "Replay" chip all read this one value, so no two of them can
// show a different time. It is a label and nothing more: it prices nothing and moves nothing (the same `extrapolate` as the Summary).

const LABEL_MS = 1000;

/** `polled` is the last answered thread time. While `running`, the value is that time plus the wall time since it changed, at `speed`. */
export function useShownClock(polled: string, running: boolean, speed: Speed): string {
  const [base, setBase] = useState(() => ({ clock: polled, at: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  // A new answer restarts the count. After the render that saw it (not inside it), so the first frame shows the answer as it is.
  useEffect(() => {
    const timer = setTimeout(() => {
      const at = Date.now();
      setBase({ clock: polled, at });
      setNow(at);
    }, 0);
    return () => clearTimeout(timer);
  }, [polled]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), LABEL_MS);
    return () => clearInterval(timer);
  }, [running]);
  if (base.clock !== polled) return polled;
  return extrapolate({ clock: polled, running, speed, state: running ? "running" : "paused" }, now - base.at) ?? polled;
}
