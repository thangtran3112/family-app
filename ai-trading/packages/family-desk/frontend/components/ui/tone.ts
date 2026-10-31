// The one tone vocabulary (design-component-system §4.3, ruling 4): meaning names, never colour names. Pure data, so node --test
// can import it. Every primitive sets `data-tone={tone}`; app/globals.css maps each name to `--tone`, the only tone → colour table.
// Domain states (alert status, delivery result, strategy stage…) map to a Tone in lib/desk/*View.ts, never in a component file.

export const TONES = ["up", "down", "warn", "neutral", "ai"] as const;

/** up = gain / good, down = loss / failure, warn = attention (amber), neutral = no signal, ai = machine-made. */
export type Tone = (typeof TONES)[number];
