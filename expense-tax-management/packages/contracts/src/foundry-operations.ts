import { z } from "zod";
import { AiOperationSchema } from "./foundry-catalog.js";
import { ProviderCallOutcomeSchema, ReservationStatusSchema } from "./foundry-quotas.js";
import { TimestampSchema } from "./expenses.js";

export const ProviderCallLogSchema = z.strictObject({
  id: z.uuid(), reservationId: z.uuid(), attemptNumber: z.int().positive(),
  providerIdempotencyKey: z.string().nullable(), outcome: ProviderCallOutcomeSchema,
  latencyMs: z.int().nonnegative().nullable(), costUsd: z.string().nullable(), createdAt: TimestampSchema,
});
export type ProviderCallLog = z.infer<typeof ProviderCallLogSchema>;
export const ProviderCallLogListSchema = z.strictObject({ items: z.array(ProviderCallLogSchema) });

export const QuotaPeriodSchema = z.strictObject({
  id: z.uuid(), tenantAiQuotaId: z.uuid(), tenantId: z.uuid(), operation: AiOperationSchema,
  aiModelId: z.uuid().nullable(), periodKey: z.string(), consumedJobs: z.int().nonnegative(),
  reservedJobs: z.int().nonnegative(), maxJobs: z.int().nonnegative().nullable(), updatedAt: TimestampSchema,
});
export type QuotaPeriod = z.infer<typeof QuotaPeriodSchema>;
export const QuotaPeriodListSchema = z.strictObject({ items: z.array(QuotaPeriodSchema) });

export const ReconciliationQueueItemSchema = z.strictObject({
  reservationId: z.uuid(), tenantId: z.uuid(), operation: AiOperationSchema,
  aiModelId: z.uuid(), status: ReservationStatusSchema, createdAt: TimestampSchema,
  callStartedAt: TimestampSchema.nullable(), attempts: z.array(ProviderCallLogSchema),
  releasedApprovalCount: z.int().nonnegative(),
});
export type ReconciliationQueueItem = z.infer<typeof ReconciliationQueueItemSchema>;
export const ReconciliationQueueSchema = z.strictObject({ items: z.array(ReconciliationQueueItemSchema) });

export const FoundryAuditEventSchema = z.strictObject({
  id: z.uuid(), actorPlatformSubject: z.string().nullable(), actorServicePrincipal: z.string().nullable(),
  action: z.string(), outcome: z.enum(["success", "denied", "failure"]),
  resourceType: z.string(), resourceId: z.string().nullable(), requestId: z.string(), createdAt: TimestampSchema,
});
export type FoundryAuditEvent = z.infer<typeof FoundryAuditEventSchema>;
export const FoundryAuditEventListSchema = z.strictObject({ items: z.array(FoundryAuditEventSchema) });

export const OperationsListQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).optional() });
