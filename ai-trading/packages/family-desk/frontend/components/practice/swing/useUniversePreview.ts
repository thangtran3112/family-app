"use client";

import { useEffect, useState } from "react";
import { DeskApiError } from "@/lib/api/client";
import { PREVIEW_DEBOUNCE_MS, PREVIEW_POLL_MS, pollExpired } from "@/lib/replay/hubSwing";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { previewSwingUniverse, type SwingPreviewRequest, type UniversePreview } from "@/lib/replay/swingApi";
import { previewKey, previewProblems, previewRequest, swingProblems, type SwingDraft, type SwingProblems } from "@/lib/replay/swingSetup";
import { isPreparing } from "@/lib/replay/universeView";

type Answer = {
  /** The request this answer belongs to. */
  key: string;
  preview: UniversePreview | null;
  /** Server problems (422) as field messages, or the plain sentence when the call itself failed. */
  problems: SwingProblems;
  failure: string | null;
  /** The ten minutes of asking ran out while the data was still being prepared. */
  expired: boolean;
};

export type UniversePreviewState = {
  /** The newest table, kept on screen while the next one is on its way. */
  preview: UniversePreview | null;
  /** The table on screen answers the inputs on screen. */
  fresh: boolean;
  /** A request is waiting to go out or is in flight. */
  busy: boolean;
  /** Local problems with the inputs (first day, sessions, target) plus the server's for this request. */
  problems: SwingProblems;
  failure: string | null;
  expired: boolean;
  /** Ask again after a failed request. */
  retry: () => void;
};

/**
 * The live universe table of the swing setup (02p c1): asks `POST /threads/swing-universe` when an input that matters
 * changes (debounced, the older request aborted) and asks again every 3 seconds while the pool data is `preparing`, for
 * at most 10 minutes. Everything stops on unmount. With a problem in the inputs no request goes out.
 */
export function useUniversePreview(draft: SwingDraft, enabled: boolean, now: Date): UniversePreviewState {
  const local = previewProblems(draft, now);
  const blocked = Object.keys(local).length > 0;
  const key = enabled && !blocked ? previewKey(previewRequest(draft)) : null;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (key === null) return;
    const request = JSON.parse(key) as SwingPreviewRequest;
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: number | undefined;
    const ask = (delay: number) => {
      timer = window.setTimeout(() => {
        previewSwingUniverse(request, { signal: controller.signal }).then(
          (preview) => {
            if (controller.signal.aborted) return;
            const expired = isPreparing(preview) && pollExpired(startedAt, Date.now());
            setAnswer({ key, preview, problems: {}, failure: null, expired });
            if (isPreparing(preview) && !expired) ask(PREVIEW_POLL_MS);
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            const problems = error instanceof DeskApiError && error.status === 422 ? swingProblems(error.problems) : {};
            const failure = Object.keys(problems).length > 0 ? null : error instanceof DeskApiError && error.detail ? error.detail : PRACTICE_COPY.swingPreviewError;
            setAnswer((current) => ({ key, preview: current?.preview ?? null, problems, failure, expired: false }));
          },
        );
      }, delay);
    };
    ask(PREVIEW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, attempt]);

  const current = key !== null && answer?.key === key ? answer : null;
  return {
    preview: answer?.preview ?? null,
    fresh: current !== null && current.preview !== null && current.failure === null && Object.keys(current.problems).length === 0,
    busy: key !== null && (current === null || (current.failure === null && isPreparing(current.preview) && !current.expired)),
    problems: { ...local, ...(current?.problems ?? {}) },
    failure: current?.failure ?? null,
    expired: current?.expired ?? false,
    retry: () => setAttempt((n) => n + 1),
  };
}
