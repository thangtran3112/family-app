from __future__ import annotations

from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from expense_contracts.generated import JobReferenceV1

    from ai_worker.activities import (
        FoundationEchoActivities,
        MarkRunningInput,
        SubmitEchoResultInput,
    )

# A freshly created ProcessingJob starts at version 1 (createJob) and is
# always bumped to version 2 by dispatchPendingJobs before the workflow
# starts (see services/app-api/src/domain/processing-jobs.ts). This
# workflow's only job is to prove the full loop end to end, so it can
# safely assume that fixed starting version rather than threading a version
# field through the deliberately minimal JobReferenceV1 contract.
DISPATCHED_JOB_VERSION = 2


@workflow.defn(name="FoundationEchoWorkflow")
class FoundationEchoWorkflow:
    @workflow.run
    async def run(self, job_reference: JobReferenceV1) -> None:
        new_version = await workflow.execute_activity(
            FoundationEchoActivities.mark_running,
            MarkRunningInput(
                job_reference=job_reference,
                expected_job_version=DISPATCHED_JOB_VERSION,
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )
        await workflow.execute_activity(
            FoundationEchoActivities.submit_echo_result,
            SubmitEchoResultInput(
                job_reference=job_reference,
                expected_job_version=new_version,
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )
