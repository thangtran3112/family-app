import { z } from "zod";

/**
 * Stable Temporal identifiers consumed by App API and the Expense-owned
 * TypeScript workflow worker. They are environment-independent routing
 * contracts, not deploy-time configuration.
 */
export const AI_WORKER_TASK_QUEUE = "expense-tax-processing";
export const FOUNDATION_ECHO_WORKFLOW_TYPE = "FoundationEchoWorkflow";
export const OCR_RECEIPT_WORKFLOW_TYPE = "OcrReceiptWorkflow";
export const FORWARDED_RECEIPT_WORKFLOW_TYPE = "ForwardedReceiptWorkflow";
export const OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1";
export const EXPENSE_ENRICHMENT_WORKFLOW_TYPE = "ExpenseEnrichmentWorkflow";
export const EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION = "expense-enrichment-v1";

export const WorkflowTypeSchema = z.enum([
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  OCR_RECEIPT_WORKFLOW_TYPE,
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
]);
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

// Existing workflows complete through App API callbacks and return no value
// through Temporal history.
export const WorkflowResultSchema = z.void();
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
