import { z } from "zod";

import { TimestampSchema, VersionSchema } from "./expenses.js";

export const ProcessingJobStatusSchema = z.enum([
  "PENDING",
  "DISPATCHED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);
export type ProcessingJobStatus = z.infer<typeof ProcessingJobStatusSchema>;

export const ProcessingJobSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  workflowType: z.string().min(1),
  workflowId: z.string().min(1),
  taskQueue: z.string().min(1),
  runId: z.string().min(1).nullable(),
  status: ProcessingJobStatusSchema,
  targetAggregateType: z.string().min(1).nullable(),
  targetAggregateId: z.uuid().nullable(),
  expectedAggregateVersion: z.int().nullable(),
  allowedResultSchemaVersion: z.string().min(1),
  result: z.record(z.string(), z.unknown()).nullable(),
  errorMessage: z.string().nullable(),
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  dispatchedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
});
export type ProcessingJob = z.infer<typeof ProcessingJobSchema>;

export const ProcessingJobParamsSchema = z.strictObject({
  jobId: z.uuid(),
});
export type ProcessingJobParams = z.infer<typeof ProcessingJobParamsSchema>;

export const DispatchPendingJobsResponseSchema = z.strictObject({
  dispatchedCount: z.int().min(0),
});
export type DispatchPendingJobsResponse = z.infer<
  typeof DispatchPendingJobsResponseSchema
>;
