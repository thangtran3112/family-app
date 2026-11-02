// The one place a Practice route reads an id (or a week number) from its URL (D-164, D-193).

/** A positive whole number from a URL parameter; null when it is missing or is not one (`abc`, `0`, `-1`, `1.5`, `2x`, an empty value, a number too big to be exact). */
export function wholeParam(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * What a route's id parameter says before any load. Three answers, one pattern on every route:
 * - `id` is a number: load it (the server answers 404 for one it does not know: "not found"; a failed read: the retry block);
 * - `id` is null and `given` is false: she chose nothing, so "not selected" (the thread picker);
 * - `id` is null and `given` is true: she gave an id that cannot name anything (`abc`, `0`), so "not found", never "not selected".
 */
export function routeId(raw: string | null): { id: number | null; given: boolean } {
  return { id: wholeParam(raw), given: raw !== null };
}
