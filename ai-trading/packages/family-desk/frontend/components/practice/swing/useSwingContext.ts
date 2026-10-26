"use client";

import { useEffect, useMemo, useState } from "react";
import { loadThread } from "@/lib/desk/replay";
import { weekFigures, weekRange, type WeekFigures } from "@/lib/replay/playView";
import type { Hold } from "@/lib/replay/schemas";
import { loadHolds, loadWeeks, type WeekRow } from "@/lib/replay/swingApi";
import type { PracticeThread } from "@/lib/replay/threads";

export type SwingContext = {
  /** The thread's swing setup (open-hold limit, risk per hold); null until it loads. */
  setup: NonNullable<PracticeThread["swing"]> | null;
  /** The thread's plan (the swing week's loss and entry limits); null until it loads. */
  plan: PracticeThread["plan"] | null;
  /** This week's entries and realized result; null while unknown (a failed read leaves the plan rows off, never a guess). */
  week: WeekFigures | null;
};

/**
 * What the swing workspace needs beyond the session answer (02p b2): the thread's setup and plan and the week's holds.
 * The thread and the week list are read once; the holds again after every mark of this session (`marks`).
 */
export function useSwingContext(threadId: number | null, weekNo: number | null | undefined, marks: number): SwingContext {
  const [thread, setThread] = useState<PracticeThread | null>(null);
  const [weeks, setWeeks] = useState<WeekRow[] | null>(null);
  const [holds, setHolds] = useState<Hold[] | null>(null);

  useEffect(() => {
    if (threadId === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    loadThread(threadId, { signal }).then((loaded) => !signal.aborted && setThread(loaded.thread)).catch(() => undefined);
    loadWeeks(threadId, { signal }).then((loaded) => !signal.aborted && setWeeks(loaded.weeks)).catch(() => undefined);
    return () => controller.abort();
  }, [threadId]);

  useEffect(() => {
    if (threadId === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    loadHolds(threadId, "all", { signal }).then((loaded) => !signal.aborted && setHolds(loaded.holds)).catch(() => undefined);
    return () => controller.abort();
  }, [threadId, marks]);

  const week = useMemo(() => {
    const range = weeks === null ? null : weekRange(weeks, weekNo);
    return range === null || holds === null ? null : weekFigures(holds, range);
  }, [weeks, holds, weekNo]);

  return { setup: thread?.swing ?? null, plan: thread?.plan ?? null, week };
}
