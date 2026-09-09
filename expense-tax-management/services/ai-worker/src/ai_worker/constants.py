"""Stable cross-language identifiers for Temporal task queues and workflow
types.

Keep in sync with
packages/contracts/src/internal/task-queues.ts. Both sides assert the exact
literal value in their own test suite (see test_constants.py here and
phase-0l-contracts.test.ts on the TypeScript side) so drift fails loudly
instead of silently mismatching task queue names, which would silently
strand dispatched workflows with no worker ever polling them.
"""

TASK_QUEUE = "expense-tax-ai-worker"
FOUNDATION_ECHO_WORKFLOW_TYPE = "FoundationEchoWorkflow"
OCR_RECEIPT_WORKFLOW_TYPE = "OcrReceiptWorkflow"
FORWARDED_RECEIPT_WORKFLOW_TYPE = "ForwardedReceiptWorkflow"
OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1"
