// When a followed chart says it is not updating (ADR-0022): the thread clock runs on the server and the screen polls it, so a screen that
// stops getting answers must say so instead of showing a ticking label over bars that stand still. Two failed polls in a row, or no answer for
// ten seconds while the tab is in view.

export const STALE_FAILURES = 2;
export const STALE_AFTER_MS = 10_000;

/** `failures` sync polls in a row have failed, and the last answer came `sinceAnswerMs` ago. */
export const notUpdating = (failures: number, sinceAnswerMs: number): boolean => failures >= STALE_FAILURES || sinceAnswerMs > STALE_AFTER_MS;
