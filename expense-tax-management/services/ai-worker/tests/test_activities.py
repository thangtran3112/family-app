import uuid

import respx
from expense_contracts.generated import JobReferenceV1
from httpx import Response
from temporalio.testing import ActivityEnvironment

from ai_worker.activities import (
    FOUNDATION_ECHO_RESULT_SCHEMA_VERSION,
    FoundationEchoActivities,
    MarkRunningInput,
    SubmitEchoResultInput,
)
from ai_worker.app_api_client import AppApiClient

JOB_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
BASE_URL = "http://app-api.test"


def job_reference() -> JobReferenceV1:
    return JobReferenceV1(
        schemaVersion=1,
        jobId=JOB_ID,
        workflowType="FoundationEchoWorkflow",
        workflowId=f"job-{JOB_ID}",
    )


@respx.mock
async def test_mark_running_posts_the_expected_status_update():
    route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    activities = FoundationEchoActivities(
        AppApiClient(base_url=BASE_URL, service_token="test-token")
    )
    env = ActivityEnvironment()

    new_version = await env.run(
        activities.mark_running,
        MarkRunningInput(job_reference=job_reference(), expected_job_version=2),
    )

    assert new_version == 3
    assert route.called
    sent_body = route.calls[0].request.content
    assert b'"status":"RUNNING"' in sent_body
    assert b'"expectedJobVersion":2' in sent_body
    assert f'"idempotencyKey":"{JOB_ID}:status:running"'.encode() in sent_body
    assert route.calls[0].request.headers["authorization"] == "Bearer test-token"


@respx.mock
async def test_submit_echo_result_posts_the_expected_result():
    route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/result").mock(
        return_value=Response(200, json={"version": 4})
    )
    activities = FoundationEchoActivities(
        AppApiClient(base_url=BASE_URL, service_token="test-token")
    )
    env = ActivityEnvironment()

    new_version = await env.run(
        activities.submit_echo_result,
        SubmitEchoResultInput(job_reference=job_reference(), expected_job_version=3),
    )

    assert new_version == 4
    assert route.called
    sent_body = route.calls[0].request.content
    assert b'"status":"SUCCEEDED"' in sent_body
    assert (
        f'"resultSchemaVersion":"{FOUNDATION_ECHO_RESULT_SCHEMA_VERSION}"'.encode()
        in sent_body
    )
    assert f'"result":{{"echo":"{JOB_ID}"}}'.encode() in sent_body
