import { z } from "zod";

import { AiOperationSchema } from "./foundry-catalog.js";
import { TimestampSchema } from "./expenses.js";

export const QuotaPeriodTypeSchema = z.enum(["monthly", "unlimited"]);
export type QuotaPeriodType = z.infer<typeof QuotaPeriodTypeSchema>;

export const ReservationStatusSchema = z.enum([
  "RESERVED",
  "CALL_STARTED",
  "CONSUMED",
  "RELEASED",
  "RECONCILIATION_REQUIRED",
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

export const ProviderCallOutcomeSchema = z.enum(["accepted", "failed", "pending"]);
export type ProviderCallOutcome = z.infer<typeof ProviderCallOutcomeSchema>;

export const ReconciliationDecisionSchema = z.enum(["consumed", "released"]);
export type ReconciliationDecision = z.infer<typeof ReconciliationDecisionSchema>;

export const TenantAiQuotaSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  operation: AiOperationSchema,
  aiModelId: z.uuid().nullable(),
  periodType: QuotaPeriodTypeSchema,
  maxJobs: z.number().int().nonnegative().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TenantAiQuota = z.infer<typeof TenantAiQuotaSchema>;

export const TenantAiQuotaCreateRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  operation: AiOperationSchema,
  aiModelId: z.uuid().nullable().optional(),
  periodType: QuotaPeriodTypeSchema,
  maxJobs: z.number().int().nonnegative().nullable(),
});
export type TenantAiQuotaCreateRequest = z.infer<
  typeof TenantAiQuotaCreateRequestSchema
>;

export const TenantAiQuotaListSchema = z.strictObject({
  items: z.array(TenantAiQuotaSchema),
});
export type TenantAiQuotaList = z.infer<typeof TenantAiQuotaListSchema>;

export const AiQuotaReservationSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  operation: AiOperationSchema,
  aiModelId: z.uuid(),
  idempotencyKey: z.string().min(1).max(200),
  status: ReservationStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  callStartedAt: TimestampSchema.nullable(),
  resolvedAt: TimestampSchema.nullable(),
});
export type AiQuotaReservation = z.infer<typeof AiQuotaReservationSchema>;

export const AiQuotaReservationCreateRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  operation: AiOperationSchema,
  aiModelId: z.uuid(),
  idempotencyKey: z.string().min(1).max(200),
});
export type AiQuotaReservationCreateRequest = z.infer<
  typeof AiQuotaReservationCreateRequestSchema
>;

export const ReservationParamsSchema = z.strictObject({
  id: z.uuid(),
});
export type ReservationParams = z.infer<typeof ReservationParamsSchema>;

export const ReservationAttemptParamsSchema = z.strictObject({
  id: z.uuid(),
  attemptNumber: z.coerce.number().int().positive(),
});
export type ReservationAttemptParams = z.infer<
  typeof ReservationAttemptParamsSchema
>;

export const ProviderCallStartedRequestSchema = z.strictObject({
  providerIdempotencyKey: z.string().min(1).max(200).nullable().optional(),
});
export type ProviderCallStartedRequest = z.infer<
  typeof ProviderCallStartedRequestSchema
>;

export const ProviderCallOutcomeRequestSchema = z.strictObject({
  outcome: ProviderCallOutcomeSchema,
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  costUsd: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable().optional(),
});
export type ProviderCallOutcomeRequest = z.infer<
  typeof ProviderCallOutcomeRequestSchema
>;

export const ReconciliationResolveRequestSchema = z.strictObject({
  decision: ReconciliationDecisionSchema,
  reason: z.string().min(1).max(2000),
  evidence: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ReconciliationResolveRequest = z.infer<
  typeof ReconciliationResolveRequestSchema
>;

export const QuotaStatusQuerySchema = z.strictObject({
  tenantId: z.uuid(),
  operation: AiOperationSchema,
});
export type QuotaStatusQuery = z.infer<typeof QuotaStatusQuerySchema>;

export const QuotaStatusResponseSchema = z.strictObject({
  isAvailable: z.boolean(),
  remainingJobs: z.number().int().nonnegative().nullable(),
  resetsAt: TimestampSchema.nullable(),
});
export type QuotaStatusResponse = z.infer<typeof QuotaStatusResponseSchema>;

export const EntitlementSyncRequestSchema = z.strictObject({
  appApiBaseUrl: z.url(),
  appApiServiceToken: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
});
export type EntitlementSyncRequest = z.infer<typeof EntitlementSyncRequestSchema>;

export const EntitlementSyncResponseSchema = z.strictObject({
  syncedCount: z.number().int().nonnegative(),
  nextAfterSequence: z.number().int().nonnegative().nullable(),
});
export type EntitlementSyncResponse = z.infer<
  typeof EntitlementSyncResponseSchema
>;
