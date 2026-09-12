import { z } from "zod";

import {
  CurrencySchema,
  DateOnlySchema,
  DecimalMoneySchema,
  TimestampSchema,
  VersionSchema,
} from "./expenses.js";

const ScopeFields = {
  tenantId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
};

export const DuplicateMatchTypeSchema = z.enum([
  "file_sha256",
  "fingerprint",
  "fuzzy_fields",
]);
export type DuplicateMatchType = z.infer<typeof DuplicateMatchTypeSchema>;

export const DuplicateMatchStatusSchema = z.enum([
  "pending",
  "merged",
  "separate",
  "dismissed",
]);
export type DuplicateMatchStatus = z.infer<typeof DuplicateMatchStatusSchema>;

export const DuplicateResolutionActionSchema = z.enum([
  "merge",
  "keep_both",
  "discard_new",
]);
export type DuplicateResolutionAction = z.infer<typeof DuplicateResolutionActionSchema>;

export const DeduplicationEvidenceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  sourceFileId: z.uuid(),
  merchant: z.string().trim().min(1).max(200),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
  orderNumber: z.string().trim().min(1).max(200).optional(),
  expectedJobVersion: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
});
export type DeduplicationEvidenceV1 = z.infer<typeof DeduplicationEvidenceV1Schema>;

export const DuplicateMatchEvidenceSchema = z
  .strictObject({
    fileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    fingerprintHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    normalizedMerchant: z.string().min(1).max(200).optional(),
    amountMinorUnits: z.number().int().nonnegative().optional(),
    currency: CurrencySchema.optional(),
    incurredOn: DateOnlySchema.optional(),
    amountDifferencePercent: z.number().min(0).max(100).optional(),
    incurredOnDifferenceDays: z.number().int().nonnegative().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Duplicate evidence must contain at least one comparison field",
  });
export type DuplicateMatchEvidence = z.infer<typeof DuplicateMatchEvidenceSchema>;

export const ExpenseProvenanceSchema = z
  .strictObject({
    id: z.uuid(),
    ...ScopeFields,
    expenseId: z.uuid(),
    sourceType: z.enum(["manual_upload", "forwarded_email"]),
    sourceFileId: z.uuid().nullable(),
    inboundEmailId: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: TimestampSchema,
  })
  .refine((value) => (value.personalProfileId !== null) !== (value.businessId !== null), {
    message: "Exactly one Personal profile or business scope is required",
  })
  .refine((value) => value.sourceFileId !== null || value.inboundEmailId !== null, {
    message: "At least one source reference is required",
  })
  .refine(
    (value) =>
      (value.sourceType === "manual_upload" &&
        value.sourceFileId !== null &&
        value.inboundEmailId === null) ||
      (value.sourceType === "forwarded_email" && value.inboundEmailId !== null),
    {
      message: "Source type must match its source references",
    },
  );
export type ExpenseProvenance = z.infer<typeof ExpenseProvenanceSchema>;

export const DuplicateMatchSchema = z
  .strictObject({
    id: z.uuid(),
    ...ScopeFields,
    existingExpenseId: z.uuid(),
    candidateExpenseId: z.uuid(),
    matchType: DuplicateMatchTypeSchema,
    confidence: z.number().min(0).max(1),
    evidence: DuplicateMatchEvidenceSchema,
    status: DuplicateMatchStatusSchema,
    version: VersionSchema,
    resolvedBy: z.uuid().nullable(),
    resolvedAt: TimestampSchema.nullable(),
    resolutionIdempotencyKey: z.string().trim().min(1).max(255).nullable(),
    idempotencyKey: z.string().trim().min(1).max(255),
    createdAt: TimestampSchema,
  })
  .refine((value) => (value.personalProfileId !== null) !== (value.businessId !== null), {
    message: "Exactly one Personal profile or business scope is required",
  })
  .refine(
    (value) =>
      (value.status === "pending" &&
        value.resolvedBy === null &&
        value.resolvedAt === null &&
        value.resolutionIdempotencyKey === null) ||
      (value.status !== "pending" &&
        value.resolvedBy !== null &&
        value.resolvedAt !== null &&
        value.resolutionIdempotencyKey !== null),
    {
      message: "Resolution metadata must match match status",
    },
  );
export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;

export const DuplicateMatchListSchema = z.strictObject({
  items: z.array(DuplicateMatchSchema),
  nextCursor: z.string().nullable(),
});
export type DuplicateMatchList = z.infer<typeof DuplicateMatchListSchema>;

export const DuplicateResolutionRequestSchema = z.strictObject({
  action: DuplicateResolutionActionSchema,
  expectedMatchVersion: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
});
export type DuplicateResolutionRequest = z.infer<typeof DuplicateResolutionRequestSchema>;

export const DuplicateResolutionResponseSchema = z.strictObject({
  matchId: z.uuid(),
  action: DuplicateResolutionActionSchema,
  status: DuplicateMatchStatusSchema,
  version: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
});
export type DuplicateResolutionResponse = z.infer<typeof DuplicateResolutionResponseSchema>;
