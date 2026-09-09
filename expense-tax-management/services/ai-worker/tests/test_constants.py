from ai_worker.constants import FOUNDATION_ECHO_WORKFLOW_TYPE, TASK_QUEUE


def test_task_queue_matches_the_typescript_side():
    # Any change here is a breaking change for
    # packages/contracts/src/internal/task-queues.ts and must be updated on
    # both sides together (see phase-0l-contracts.test.ts for the mirror).
    assert TASK_QUEUE == "expense-tax-ai-worker"
    assert FOUNDATION_ECHO_WORKFLOW_TYPE == "FoundationEchoWorkflow"
