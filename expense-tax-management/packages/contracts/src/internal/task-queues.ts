/**
 * Stable cross-language identifiers for Temporal task queues and workflow
 * types. These are not secrets and not environment-specific, so they are
 * plain constants rather than env vars -- but they are also not Zod schemas,
 * so they do not flow through the JSON-Schema -> Pydantic generator.
 *
 * Keep in sync with services/ai-worker/src/ai_worker/constants.py. Both
 * sides assert the exact literal value in their own test suite so drift
 * fails loudly instead of silently mismatching task queue names (which would
 * silently strand dispatched workflows with no worker ever polling them).
 */
export const AI_WORKER_TASK_QUEUE = "expense-tax-ai-worker";
export const FOUNDATION_ECHO_WORKFLOW_TYPE = "FoundationEchoWorkflow";
export const OCR_RECEIPT_WORKFLOW_TYPE = "OcrReceiptWorkflow";
export const FORWARDED_RECEIPT_WORKFLOW_TYPE = "ForwardedReceiptWorkflow";
export const OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1";
