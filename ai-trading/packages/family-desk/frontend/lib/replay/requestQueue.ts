// The replay player's one-request-at-a-time queue (02o §d). Tasks run in the order they were queued, each after the one
// before has answered. A Step, Jump or Next-signal press may be queued with `dropAfterPause`: when an advance ahead of it
// stopped at a crossed stop (02p §k) the press drops itself, so nothing is stacked behind the pause and the playhead stays
// on the crossing until she answers the toast.

export type RequestQueue = ReturnType<typeof createRequestQueue>;

export function createRequestQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  let pauses = 0;
  return {
    /** An advance answered with a stop pause. */
    notePause: () => {
      pauses += 1;
    },
    /** Runs `task` after every earlier one. Resolves with its result, or null when it threw or was dropped. */
    run<T>(task: () => Promise<T>, { dropAfterPause = false }: { dropAfterPause?: boolean } = {}): Promise<T | null> {
      const queuedUnder = pauses;
      const next = chain.then(() => (dropAfterPause && pauses !== queuedUnder ? null : task()));
      chain = next.catch(() => undefined);
      return next.catch(() => null);
    },
  };
}
