import { z } from "zod";
import { SchemaVersionSchema } from "./strategy-common.ts";

// PracticeBlockV1 (02o-b v1): the daily-list practice plan she authors once. Each practice day her
// own filters build a candidate list for the past day she is about to replay (same screener code as
// live, inputs cut at the time she would have looked); the setup below is the ReplaySessionV1 shape
// minus symbol, day, shares and risk plan. The risk plan (stop note, signal only, max loss, max
// trades, note) belongs to the practice thread (practice-thread-v1.ts, 02r, D-007), and she sizes each
// entry herself: a v1 block that still carries `setup.plan` or `setup.shares` is rejected here, and
// the server drops those two keys from an old client's payload before it validates. Nothing is a
// boolean or null, every object is strict, and no field names an order, account or broker, as in the
// other 02k-family contracts. The server rules that need a database (the filters are hers and
// runnable, `listAt` of 08:30 or later for a premarket filter, every day finished, `firstDay` from
// 2017-01-03) are not contract rules. `maxSymbols` (02o-b2, optional) caps the names she may watch
// (star) and practise on one day; a block without it gets the server default (5, the star cap).

const HhMmSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const IsoDaySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/);
const YesNoSchema = z.enum(["yes", "no"]);

// The nested objects carry ids so the generated Pydantic classes keep their own names; the unnamed
// `Window` and `ArmedItem` stay ReplaySessionV1's.
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
    armed: z
      .array(
        z
          .strictObject({ source: z.enum(["alert_strategy", "filter"]), id: z.int().min(1) })
          .meta({ id: "PracticeArmedV1" }),
      )
      .max(5),
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
    // Accepted and ignored since the day name cap went away (a day opens any list name); old plans still carry it.
    maxSymbols: z.int().min(1).max(20).optional(),
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
