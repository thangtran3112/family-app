import { z } from "zod";
import { SchemaVersionSchema } from "./strategy-common.ts";

// PracticeBlockV1 (02o-b v1): the daily-list practice plan she authors once. Each practice day her
// own filters build a candidate list for the past day she is about to replay (same screener code as
// live, inputs cut at the time she would have looked); the setup below is the ReplaySessionV1 shape
// minus symbol and day. Nothing is a boolean or null, every object is strict, and no field names an
// order, account or broker, as in the other 02k-family contracts. The server rules that need a
// database (the filters are hers and runnable, `listAt` of 08:30 or later for a premarket filter,
// every day finished, `firstDay` from 2017-01-03) are not contract rules.

const HhMmSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const IsoDaySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/);
const SharesSchema = z.int().min(1).max(10_000);
const YesNoSchema = z.enum(["yes", "no"]);
const plainText = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/^[\u0020-\u007E\u00A0-\uD7FF\uE000-\uFFFF]+$/);

// The nested objects carry ids so the generated Pydantic classes keep their own names; the unnamed
// `Window`, `Plan` and `ArmedItem` stay ReplaySessionV1's.
const PracticeScreenSchema = z
  .strictObject({
    filters: z.array(z.strictObject({ id: z.int().min(1) })).min(1).max(3),
    listAt: HhMmSchema,
    maxList: z.int().min(20).max(50),
  })
  .meta({ id: "PracticeScreenV1" });

const PracticeSetupSchema = z
  .strictObject({
    window: z.strictObject({ from: HhMmSchema, to: HhMmSchema }).meta({ id: "PracticeWindowV1" }),
    session: z.enum(["regular", "extended"]),
    interval: z.enum(["1m", "5m", "15m"]),
    shares: SharesSchema,
    armed: z
      .array(
        z
          .strictObject({ source: z.enum(["alert_strategy", "filter"]), id: z.int().min(1) })
          .meta({ id: "PracticeArmedV1" }),
      )
      .max(5),
    plan: z
      .strictObject({
        stopRequired: YesNoSchema,
        signalOnly: YesNoSchema,
        maxLossUsd: z.int().min(1).max(100_000).optional(),
        maxTrades: z.int().min(1).max(50).optional(),
        note: plainText(1, 500).optional(),
      })
      .meta({ id: "PracticePlanV1" }),
  })
  .meta({ id: "PracticeSetupV1" });

export const PRACTICE_BLOCK_RULES = [
  { id: "window-order", description: "window.from must be before window.to" },
  { id: "window-in-session", description: "window must stay inside 04:00-20:00 ET" },
  { id: "window-in-regular", description: "a regular-session window must stay inside 09:30-16:00 ET" },
  { id: "list-time-range", description: "screen.listAt must be between 04:30 and 15:30 ET" },
  { id: "window-after-list", description: "window.from must be at or after screen.listAt" },
] as const;

const TEXT = Object.fromEntries(PRACTICE_BLOCK_RULES.map((rule) => [rule.id, rule.description]));

export const PracticeBlockV1Schema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    firstDay: IsoDaySchema,
    sessions: z.int().min(5).max(30),
    hideDates: YesNoSchema,
    screen: PracticeScreenSchema,
    setup: PracticeSetupSchema,
  })
  .superRefine((block, ctx) => {
    const { from, to } = block.setup.window;
    const regular = block.setup.session === "regular";
    const path = ["setup", "window"];
    if (from >= to) ctx.addIssue({ code: "custom", path, message: TEXT["window-order"] });
    if (from < "04:00" || to > "20:00") {
      ctx.addIssue({ code: "custom", path, message: TEXT["window-in-session"] });
    } else if (regular && (from < "09:30" || to > "16:00")) {
      ctx.addIssue({ code: "custom", path, message: TEXT["window-in-regular"] });
    }
    const listAt = block.screen.listAt;
    if (listAt < "04:30" || listAt > "15:30") {
      ctx.addIssue({ code: "custom", path: ["screen", "listAt"], message: TEXT["list-time-range"] });
    }
    if (from < listAt) ctx.addIssue({ code: "custom", path, message: TEXT["window-after-list"] });
  })
  .meta({ id: "PracticeBlockV1" });

export type PracticeBlockV1 = z.infer<typeof PracticeBlockV1Schema>;
