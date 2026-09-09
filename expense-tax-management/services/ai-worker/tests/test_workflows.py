import uuid

import respx
from expense_contracts.generated import JobReferenceV1
from httpx import Response
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from ai_worker.activities import FoundationEchoActivities
from ai_worker.app_api_client import AppApiClient
from ai_worker.constants import TASK_QUEUE
from ai_worker.workflows import FoundationEchoWorkflow

JOB_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
BASE_URL = "http://app-api.test"


@respx.mock
async def test_foundation_echo_workflow_marks_running_then_submits_result_with_chained_versions():
    status_route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    result_route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/result").mock(
        return_value=Response(200, json={"version": 4})
    )
    activities = FoundationEchoActivities(
        AppApiClient(base_url=BASE_URL, service_token="test-token")
    )

    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[FoundationEchoWorkflow],
            activities=[activities.mark_running, activities.submit_echo_result],
        ),
    ):
        await env.client.execute_workflow(
            FoundationEchoWorkflow.run,
            JobReferenceV1(
                schemaVersion=1,
                jobId=JOB_ID,
                workflowType="FoundationEchoWorkflow",
                workflowId=f"job-{JOB_ID}",
            ),
            id=f"job-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert status_route.called
    assert result_route.called
    # The workflow must thread mark_running's returned version (3) into
    # submit_echo_result's expectedJobVersion, not re-derive/guess it.
    assert b'"expectedJobVersion":3' in result_route.calls[0].request.content
