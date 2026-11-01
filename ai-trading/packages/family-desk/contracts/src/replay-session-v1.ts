import { z } from "zod";
import { SchemaVersionSchema } from "./strategy-common.ts";

// ReplaySessionV1 and PracticeMarkV1 (02o section c4): what she authors in the Practice lane. The
// session setup is validated live in the hub form and stored as jsonb; a mark is what she sends
// from the replay workspace. Nothing here is a boolean (yes/no enums instead), nothing is null, and
// every object is strict, as in the 02k specs. State rules (flat book, an open trade, the losing
// side of the last price) are server rules, not contract rules. No order, account, or broker field.

// "HH:MM" in America/New_York. [0-9], not \d (see strategy-spec-v1.ts).
const HhMmSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
// A stock or ETF ticker: no leading "/" (futures roots are rejected).
const StockTickerSchema = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/);
// "YYYY-MM-DD", an America/New_York trading day. The regex checks month and day ranges, not the
// calendar or the market; the server answers 422 for a weekend, a holiday, or a day before 2016.
const IsoDaySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/);
// A positive price, bounded.
const PriceSchema = z.number().positive().max(1_000_000);
// No share-count cap: what limits a size is the account's cash (the server's buying-power check). The bound is only
// the width of the `shares` column (a 32-bit integer).
const SharesSchema = z.int().min(1).max(2_147_483_647);

// Plain text of min..max BMP characters (no C0/C1 controls or DEL, no surrogates, so Zod's UTF-16
// length and Python's code-point length agree).
const plainText = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/^[\u0020-\u007E\u00A0-\uD7FF\uE000-\uFFFF]+$/);

const YesNoSchema = z.enum(["yes", "no"]);

export const REPLAY_WINDOW_RULES = [
  { id: "window-order", description: "window.from must be before window.to" },
  { id: "window-in-session", description: "window must stay inside 04:00-20:00 ET" },
  { id: "window-in-regular", description: "a regular-session window must stay inside 09:30-16:00 ET" },
] as const;

const WINDOW_TEXT = Object.fromEntries(REPLAY_WINDOW_RULES.map((rule) => [rule.id, rule.description]));

export const ReplaySessionV1Schema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    symbol: StockTickerSchema,
    day: IsoDaySchema,
    window: z.strictObject({ from: HhMmSchema, to: HhMmSchema }),
    session: z.enum(["regular", "extended"]),
    interval: z.enum(["1m", "5m", "15m"]),
    shares: SharesSchema,
    armed: z
      .array(z.strictObject({ source: z.enum(["alert_strategy", "filter"]), id: z.int().min(1) }))
      .max(5),
    plan: z.strictObject({
      stopRequired: YesNoSchema,
      signalOnly: YesNoSchema,
      maxLossUsd: z.int().min(1).max(100_000).optional(),
      maxTrades: z.int().min(1).max(50).optional(),
      note: plainText(1, 500).optional(),
    }),
    hideDate: YesNoSchema,
  })
  .superRefine((spec, ctx) => {
    const { from, to } = spec.window;
    const bounds = spec.session === "regular" ? ["09:30", "16:00"] : ["04:00", "20:00"];
    const path = ["window"];
    if (from >= to) ctx.addIssue({ code: "custom", path, message: WINDOW_TEXT["window-order"] });
    if (from < "04:00" || to > "20:00") {
      ctx.addIssue({ code: "custom", path, message: WINDOW_TEXT["window-in-session"] });
    } else if (spec.session === "regular" && (from < bounds[0]! || to > bounds[1]!)) {
      ctx.addIssue({ code: "custom", path, message: WINDOW_TEXT["window-in-regular"] });
    }
  })
  .meta({ id: "ReplaySessionV1" });

export const PracticeMarkV1Schema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      schemaVersion: SchemaVersionSchema,
      kind: z.enum(["long_entry", "short_entry"]),
      shares: SharesSchema.optional(),
      stopPrice: PriceSchema.optional(),
      note: plainText(1, 280).optional(),
    }),
    z.strictObject({
      schemaVersion: SchemaVersionSchema,
      kind: z.enum(["long_exit", "short_exit"]),
      note: plainText(1, 280).optional(),
    }),
    z.strictObject({ schemaVersion: SchemaVersionSchema, kind: z.literal("stop"), stopPrice: PriceSchema }),
    z.strictObject({ schemaVersion: SchemaVersionSchema, kind: z.literal("note"), note: plainText(1, 280) }),
  ])
  .meta({ id: "PracticeMarkV1" });

export type ReplaySessionV1 = z.infer<typeof ReplaySessionV1Schema>;
export type PracticeMarkV1 = z.infer<typeof PracticeMarkV1Schema>;
