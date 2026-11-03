// The lane's one-request-at-a-time queue (02o §d). Tasks run in the order they were queued, each after the one before has answered, so a mark,
// an order and the clock poll never overlap.

export type RequestQueue = ReturnType<typeof createRequestQueue>;

export function createRequestQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    /** Runs `task` after every earlier one. Resolves with its result, or null when it threw. */
    run<T>(task: () => Promise<T>): Promise<T | null> {
      const next = chain.then(task);
      chain = next.catch(() => undefined);
      return next.catch(() => null);
    },
  };
}
