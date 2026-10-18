import { z } from "zod";

import { TimestampSchema, VersionSchema } from "./expenses.js";
import {
  CaptureOcrIssueCodeSchema,
  CaptureOcrPartialFieldsV1Schema,
} from "./ocr.js";

export const PersonalOcrReviewCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
});

export const BusinessOcrReviewCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});

export const PersonalOcrReviewJobParamsSchema = PersonalOcrReviewCollectionParamsSchema.extend({
  jobId: z.uuid(),
});

export const BusinessOcrReviewJobParamsSchema = BusinessOcrReviewCollectionParamsSchema.extend({
  jobId: z.uuid(),
});

export const CaptureOcrReviewStatusQuerySchema = z.strictObject({
  status: z.literal("needs_input"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
});

export const CaptureOcrReviewItemV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  fileId: z.uuid(),
  jobVersion: VersionSchema,
  fields: CaptureOcrPartialFieldsV1Schema,
  issues: z.array(CaptureOcrIssueCodeSchema).min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type CaptureOcrReviewItemV1 = z.infer<typeof CaptureOcrReviewItemV1Schema>;

export const CaptureOcrReviewDetailV1Schema = CaptureOcrReviewItemV1Schema.extend({
  previewUrl: z.string().min(1),
  previewExpiresAt: TimestampSchema,
});
export type CaptureOcrReviewDetailV1 = z.infer<typeof CaptureOcrReviewDetailV1Schema>;

export const CaptureOcrReviewListV1Schema = z.strictObject({
  items: z.array(CaptureOcrReviewItemV1Schema),
  nextCursor: z.string().nullable(),
});
export type CaptureOcrReviewListV1 = z.infer<typeof CaptureOcrReviewListV1Schema>;

export const CaptureOcrReviewCompleteResponseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  expenseId: z.uuid(),
  jobVersion: VersionSchema,
  duplicateDecision: z.enum(["no_match", "review"]),
  duplicateMatchIds: z.array(z.uuid()),
});
export type CaptureOcrReviewCompleteResponseV1 = z.infer<
  typeof CaptureOcrReviewCompleteResponseV1Schema
>;
