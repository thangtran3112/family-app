import { z } from "zod";
import type { components } from "../api/openapi.js";

// Response shapes of `/api/desk/feedback` (02s). They mirror `ai_trading/api/schemas/feedback.py` and are checked against the
// generated OpenAPI the way lib/replay/schemas.ts is: a field the backend adds, drops or retypes breaks `pnpm typecheck`.

const finite = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });

export const FeedbackKindSchema = z.enum(["bug", "request"]);
export const FeedbackSeveritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const FeedbackStatusSchema = z.enum(["open", "in_progress", "fixed", "wont_fix", "duplicate"]);
export const FeedbackActorSchema = z.enum(["user", "owner", "claude-code", "hermes"]);

export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;
export type FeedbackSeverity = z.infer<typeof FeedbackSeveritySchema>;
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;
export type FeedbackActor = z.infer<typeof FeedbackActorSchema>;

/** A row of the dashboard list. */
export const FeedbackItemSchema = z.object({
  id: finite.int(),
  ref: z.string(),
  kind: FeedbackKindSchema,
  severity: FeedbackSeveritySchema.nullable(),
  title: z.string(),
  route: z.string(),
  area: z.string(),
  reported_by: z.string(),
  updated_at: timestamp,
  status: FeedbackStatusSchema,
  fix_ref: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["FeedbackItemOut"]>;

/** Reports per status over the whole log, not over the page. */
export const FeedbackCountsSchema = z.object({
  open: finite.int(),
  in_progress: finite.int(),
  fixed: finite.int(),
  wont_fix: finite.int(),
  duplicate: finite.int(),
}) satisfies z.ZodType<components["schemas"]["FeedbackCountsOut"]>;

export const FeedbackListSchema = z.object({
  items: z.array(FeedbackItemSchema),
  counts: FeedbackCountsSchema,
}) satisfies z.ZodType<components["schemas"]["FeedbackListOut"]>;

export const FeedbackLinkSchema = z.object({
  label: z.string().nullable(),
  url: z.string(),
}) satisfies z.ZodType<components["schemas"]["FeedbackLinkOut"]>;

export const FeedbackAttachmentSchema = z.object({
  id: finite.int(),
  filename: z.string(),
  size_bytes: finite.int(),
  content_type: z.string(),
}) satisfies z.ZodType<components["schemas"]["FeedbackAttachmentOut"]>;

/** A screenshot the server accepted; `report_id` is null while it is staged for a report not yet sent. */
export const FeedbackUploadSchema = FeedbackAttachmentSchema.extend({
  report_id: finite.int().nullable(),
}) satisfies z.ZodType<components["schemas"]["FeedbackUploadOut"]>;

export const FeedbackEventSchema = z.object({
  at: timestamp,
  actor: FeedbackActorSchema,
  from_status: FeedbackStatusSchema.nullable(),
  to_status: FeedbackStatusSchema,
  note: z.string().nullable(),
}) satisfies z.ZodType<components["schemas"]["FeedbackEventOut"]>;

export const FeedbackDetailSchema = FeedbackItemSchema.extend({
  body: z.string(),
  expected: z.string().nullable(),
  screen: z.string(),
  app_version: z.string(),
  context: z.record(z.string(), z.unknown()),
  captured_at: timestamp,
  links: z.array(FeedbackLinkSchema),
  attachments: z.array(FeedbackAttachmentSchema),
  events: z.array(FeedbackEventSchema),
  duplicate_of: finite.int().nullable(),
}) satisfies z.ZodType<components["schemas"]["FeedbackDetailOut"]>;

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;
export type FeedbackCounts = z.infer<typeof FeedbackCountsSchema>;
export type FeedbackList = z.infer<typeof FeedbackListSchema>;
export type FeedbackLink = z.infer<typeof FeedbackLinkSchema>;
export type FeedbackAttachment = z.infer<typeof FeedbackAttachmentSchema>;
export type FeedbackUpload = z.infer<typeof FeedbackUploadSchema>;
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;
export type FeedbackDetail = z.infer<typeof FeedbackDetailSchema>;
