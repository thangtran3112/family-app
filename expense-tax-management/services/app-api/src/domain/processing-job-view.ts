import type { ProcessingJob } from "@expense-tax/contracts";
import type { Selectable } from "kysely";

import type { AppDatabase } from "../database/types.js";

export type ProcessingJobRow = Selectable<
  AppDatabase["app.processing_jobs"]
>;

/**
 * Leaf mapper (no domain imports) shared by processing-jobs.js and ocr.js
 * so neither domain imports the other at runtime.
 */
export function toProcessingJob(row: ProcessingJobRow): ProcessingJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    workflowType: row.workflow_type,
    workflowId: row.workflow_id,
    taskQueue: row.task_queue,
    runId: row.run_id,
    status: row.status,
    targetAggregateType: row.target_aggregate_type,
    targetAggregateId: row.target_aggregate_id,
    expectedAggregateVersion: row.expected_aggregate_version,
    inputParams: (row.input_params as Record<string, unknown> | null) ?? {},
    allowedResultSchemaVersion: row.allowed_result_schema_version,
    result: (row.result as Record<string, unknown> | null) ?? null,
    errorMessage: row.error_message,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    dispatchedAt: row.dispatched_at ? row.dispatched_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}
