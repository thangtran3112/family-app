import { z } from "zod";

// PracticeSetupV2 (ADR-0025, freestyle thread): the setup she authors once when a thread starts. It replaces
// PracticeBlockV1 (practice-block-v1.ts), which stays the live contract until the create route switches over.
//
// A freestyle thread has no block of days and no list time: it has one start instant, a Screen (her saved filters,
// scanned at the thread's clock), and the chart setup a lane opens with. So `sessions`, `firstDay`, `screen.listAt`,
// `setup.window` and `hideDates` are gone, and so is the legacy `maxSymbols` (nothing read it after the no-cap ruling
// of 2026-10-31). `screen.maxList` is the Screen's cap: at most 49 names (the owner's 49-name rule).
//
// `startAt` is an ISO 8601 instant with an explicit offset ("2026-10-23T09:30:00-04:00" or "...Z"), whole seconds. The
// contract carries the two rules that need no calendar: it is a real date and time, and it falls on or after the first
// ET day of the practice calendar (2016-01-04, which is EST: 05:00 UTC). The rules that need data stay on the server,
// as `firstDay`'s did: that the ET day is a trading day, that its session has finished, and that `startAt` is not past
// the thread horizon (the extended close of the latest session the 15-minute embargo has released).
//
// Same conventions as the other 02k-family contracts: nothing is a boolean or null, every object is strict, and no
// field names an order, account or broker. The risk plan and the entry size belong to the practice thread
// (practice-thread-v1.ts); a setup that still carries `setup.plan` or `setup.shares` is rejected here.

const SchemaVersionV2Schema = z.literal(2);

// ISO date, "T", HH:MM:SS, then "Z" or a +/-HH:MM offset. A regular expression both validators share (the Pydantic
// mirror runs the same pattern); whether the date exists is the `start-at-real` rule.
const StartAtSchema = z
  .string()
  .regex(
    /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/,
  );

// The nested objects carry ids so the generated Pydantic classes keep their own names.
const PracticeScreenV2Schema = z
  .strictObject({
    filters: z.array(z.strictObject({ id: z.int().min(1) })).min(1).max(3),
    maxList: z.int().min(20).max(49),
  })
  .meta({ id: "PracticeScreenV2" });

const PracticeSessionSetupV2Schema = z
  .strictObject({
    interval: z.enum(["1m", "5m", "15m"]),
    session: z.enum(["regular", "extended"]),
    armed: z
      .array(
        z
          .strictObject({ source: z.enum(["alert_strategy", "filter"]), id: z.int().min(1) })
          .meta({ id: "PracticeArmedV2" }),
      )
      .max(5),
  })
  .meta({ id: "PracticeSessionSetupV2" });

export const PRACTICE_SETUP_RULES = [
  { id: "start-at-real", description: "startAt must be a real date and time" },
  { id: "start-at-floor", description: "startAt must be on or after 2016-01-04 ET" },
] as const;

const TEXT = Object.fromEntries(PRACTICE_SETUP_RULES.map((rule) => [rule.id, rule.description]));

// 2016-01-04 00:00 ET. January is EST (UTC-5), so the first ET day starts at 05:00 UTC: the rule needs no time zone data.
const START_AT_FLOOR_MS = Date.UTC(2016, 0, 4, 5, 0, 0);

// `Date.parse` rolls "2026-02-31" over to March 3, so the date part is checked on its own. (`Date.UTC` reads the years
// 0-99 as 1900-1999; every such year is before the floor and rejected either way.)
function isRealDate(startAt: string): boolean {
  const [year, month, day] = startAt.slice(0, 10).split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const PracticeSetupV2Schema = z
  .strictObject({
    schemaVersion: SchemaVersionV2Schema,
    startAt: StartAtSchema,
    screen: PracticeScreenV2Schema,
    setup: PracticeSessionSetupV2Schema,
  })
  .superRefine((setup, ctx) => {
    const path = ["startAt"];
    if (!isRealDate(setup.startAt)) {
      ctx.addIssue({ code: "custom", path, message: TEXT["start-at-real"] });
    } else if (Date.parse(setup.startAt) < START_AT_FLOOR_MS) {
      ctx.addIssue({ code: "custom", path, message: TEXT["start-at-floor"] });
    }
  })
  .meta({ id: "PracticeSetupV2" });

export type PracticeSetupV2 = z.infer<typeof PracticeSetupV2Schema>;
