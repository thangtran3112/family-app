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

# Enrichment workflow constants — mirror exact TS literals in task-queues.ts.
EXPENSE_ENRICHMENT_WORKFLOW_TYPE = "ExpenseEnrichmentWorkflow"
EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION = "expense-enrichment-v1"

# Evaluator constants — mirror TS ENRICHMENT_RULES_VERSION / ENRICHMENT_RULE_KEYS.
ENRICHMENT_RULES_VERSION: int = 1
ENRICHMENT_RULE_KEYS: tuple[str, ...] = ("merchant", "weekend", "selected_category")
