from __future__ import annotations

from expense_contracts.generated import (
    JobReferenceV1,
    JobResultSubmitRequestV1,
    JobStatusUpdateRequestV1,
)
from pydantic import BaseModel
from temporalio import activity

from ai_worker.app_api_client import AppApiClient

FOUNDATION_ECHO_RESULT_SCHEMA_VERSION = "foundation-echo-v1"


class MarkRunningInput(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    expected_job_version: int


class SubmitEchoResultInput(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    expected_job_version: int


class FoundationEchoActivities:
    """Bound-method activities so a real or fake AppApiClient can be
    injected for testing, while keeping each activity's own payload to a
    single Pydantic input struct Temporal can serialize across the
    workflow/activity boundary. Each activity returns the ProcessingJob's
    new version so the workflow can chain the next callback's
    expectedJobVersion without a separate read (the worker only has
    write scopes, no GET-job scope).
    """

    def __init__(self, app_api_client: AppApiClient) -> None:
        self._app_api_client = app_api_client

    @activity.defn(name="mark_running")
    async def mark_running(self, input: MarkRunningInput) -> int:
        job_id = str(input.job_reference.jobId)
        return await self._app_api_client.update_status(
            job_id,
            JobStatusUpdateRequestV1(
                schemaVersion=1,
                status="RUNNING",
                idempotencyKey=f"{job_id}:status:running",
                expectedJobVersion=input.expected_job_version,
            ),
        )

    @activity.defn(name="submit_echo_result")
    async def submit_echo_result(self, input: SubmitEchoResultInput) -> int:
        job_id = str(input.job_reference.jobId)
        return await self._app_api_client.submit_result(
            job_id,
            JobResultSubmitRequestV1(
                schemaVersion=1,
                status="SUCCEEDED",
                idempotencyKey=f"{job_id}:result:succeeded",
                expectedJobVersion=input.expected_job_version,
                resultSchemaVersion=FOUNDATION_ECHO_RESULT_SCHEMA_VERSION,
                result={"echo": job_id},
            ),
        )
