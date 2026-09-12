import hashlib
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
from ai_worker.foundry_client import FoundryClient
from ai_worker.ocr_activities import OcrReceiptActivities
from ai_worker.workflows import ForwardedReceiptWorkflow, OcrReceiptWorkflow

JOB_ID = uuid.UUID("77777777-7777-4777-8777-777777777777")
TENANT_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
FILE_ID = uuid.UUID("44444444-4444-4444-8444-444444444444")
MODEL_ID = uuid.UUID("55555555-5555-4555-8555-555555555555")
RESERVATION_ID = uuid.UUID("66666666-6666-4666-8666-666666666666")
APP_BASE = "http://app-api.test"
FOUNDRY_BASE = "http://foundry.test"
RECEIPT_BYTES = b"%PDF-1.4 fake receipt bytes"
RECEIPT_SHA = hashlib.sha256(RECEIPT_BYTES).hexdigest()


def job_reference() -> JobReferenceV1:
    return JobReferenceV1(
        schemaVersion=1,
        jobId=JOB_ID,
        workflowType="OcrReceiptWorkflow",
        workflowId=f"job-{JOB_ID}",
    )


def mock_happy_path(reserve_conflict: bool = False):
    respx.get(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/ocr-input").mock(
        return_value=Response(
            200,
            json={
                "schemaVersion": 1,
                "fileId": str(FILE_ID),
                "modeKey": "ocr_mode_balanced",
                "expectedSha256": RECEIPT_SHA,
                "tenantId": str(TENANT_ID),
            },
        )
    )
    respx.post(f"{APP_BASE}/internal/v1/files/{FILE_ID}/read-url").mock(
        return_value=Response(200, json={"url": f"{APP_BASE}/signed-bytes"})
    )
    respx.get(f"{APP_BASE}/signed-bytes").mock(
        return_value=Response(200, content=RECEIPT_BYTES)
    )
    respx.get(f"{FOUNDRY_BASE}/internal/v1/effective-route").mock(
        return_value=Response(
            200,
            json={
                "aiModeId": str(uuid.uuid4()),
                "routeVersionId": str(uuid.uuid4()),
                "routeVersionNumber": 1,
                "aiModelId": str(MODEL_ID),
                "providerKind": "fake",
                "providerModelId": "fake-ocr-v1",
            },
        )
    )
    if reserve_conflict:
        respx.post(f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations").mock(
            return_value=Response(409, json={"error": {"code": "CONFLICT"}})
        )
    else:
        respx.post(f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations").mock(
            return_value=Response(
                200, json={"id": str(RESERVATION_ID), "status": "RESERVED"}
            )
        )
    respx.post(
        f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations/{RESERVATION_ID}/call-started"
    ).mock(return_value=Response(200, json={"id": str(RESERVATION_ID)}))
    respx.post(
        f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations/{RESERVATION_ID}/attempts/1/outcome"
    ).mock(return_value=Response(200, json={"id": str(RESERVATION_ID)}))
    status_route = respx.post(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    result_route = respx.post(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/result").mock(
        return_value=Response(200, json={"version": 4})
    )
    return status_route, result_route


@respx.mock
async def test_ocr_workflow_runs_the_full_pipeline_to_succeeded():
    status_route, result_route = mock_happy_path()
    dedup_route = respx.post(
        f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/deduplication"
    ).mock(return_value=Response(200, json={"decision": "no_match", "matchIds": []}))
    app_api = AppApiClient(base_url=APP_BASE, service_token="app-token")
    ocr = OcrReceiptActivities(
        app_api, FoundryClient(base_url=FOUNDRY_BASE, service_token="foundry-token")
    )
    echo = FoundationEchoActivities(app_api)

    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[OcrReceiptWorkflow],
            activities=[
                echo.mark_running,
                ocr.ocr_get_input,
                ocr.ocr_download_receipt,
                ocr.ocr_resolve_route,
                ocr.ocr_reserve,
                ocr.ocr_mark_call_started,
                ocr.ocr_run_extraction,
                ocr.ocr_record_accepted,
                ocr.ocr_release,
                ocr.ocr_submit_extraction,
                ocr.ocr_record_deduplication,
                ocr.ocr_submit_failed,
                ocr.ocr_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            OcrReceiptWorkflow.run,
            job_reference(),
            id=f"job-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert status_route.called
    assert result_route.called
    sent = result_route.calls[0].request.content
    assert b'"status":"SUCCEEDED"' in sent
    assert b'"merchant":"Fake OCR Merchant"' in sent
    assert b'"resultSchemaVersion":"ocr-extraction-v1"' in sent
    assert dedup_route.called
    assert respx.calls.index(result_route.calls[0]) < respx.calls.index(
        dedup_route.calls[0]
    )
    assert b'"expectedJobVersion":4' in dedup_route.calls[0].request.content
    assert (
        b'"idempotencyKey":"77777777-7777-4777-8777-777777777777:ocr:dedup:v1"'
        in dedup_route.calls[0].request.content
    )


@respx.mock
async def test_ocr_workflow_maps_quota_conflict_to_a_typed_failed_result():
    # Quota exhausted: reserve 409s, the job must land FAILED with the
    # QUOTA_BLOCKED marker -- never throw, never stall.
    _, result_route = mock_happy_path(reserve_conflict=True)
    app_api = AppApiClient(base_url=APP_BASE, service_token="app-token")
    ocr = OcrReceiptActivities(
        app_api, FoundryClient(base_url=FOUNDRY_BASE, service_token="foundry-token")
    )
    echo = FoundationEchoActivities(app_api)

    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[OcrReceiptWorkflow],
            activities=[
                echo.mark_running,
                ocr.ocr_get_input,
                ocr.ocr_download_receipt,
                ocr.ocr_resolve_route,
                ocr.ocr_reserve,
                ocr.ocr_mark_call_started,
                ocr.ocr_run_extraction,
                ocr.ocr_record_accepted,
                ocr.ocr_release,
                ocr.ocr_submit_extraction,
                ocr.ocr_record_deduplication,
                ocr.ocr_submit_failed,
                ocr.ocr_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            OcrReceiptWorkflow.run,
            job_reference(),
            id=f"job-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert result_route.called
    sent = result_route.calls[0].request.content
    assert b'"status":"FAILED"' in sent
    assert b"QUOTA_BLOCKED" in sent


@respx.mock
async def test_ocr_workflow_retries_dedup_and_fails_with_succeeded_result_version():
    status_route, result_route = mock_happy_path()
    respx.post(
        f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations/{RESERVATION_ID}/release"
    ).mock(return_value=Response(200, json={"id": str(RESERVATION_ID)}))
    dedup_route = respx.post(
        f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/deduplication"
    ).mock(return_value=Response(503, json={"error": "temporary outage"}))
    app_api = AppApiClient(base_url=APP_BASE, service_token="app-token")
    ocr = OcrReceiptActivities(
        app_api, FoundryClient(base_url=FOUNDRY_BASE, service_token="foundry-token")
    )
    echo = FoundationEchoActivities(app_api)

    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[OcrReceiptWorkflow],
            activities=[
                echo.mark_running,
                ocr.ocr_get_input,
                ocr.ocr_download_receipt,
                ocr.ocr_resolve_route,
                ocr.ocr_reserve,
                ocr.ocr_mark_call_started,
                ocr.ocr_run_extraction,
                ocr.ocr_record_accepted,
                ocr.ocr_release,
                ocr.ocr_submit_extraction,
                ocr.ocr_record_deduplication,
                ocr.ocr_submit_failed,
                ocr.ocr_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            OcrReceiptWorkflow.run,
            job_reference(),
            id=f"job-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert len(dedup_route.calls) == 5
    assert len(result_route.calls) == 1
    assert len(status_route.calls) == 2
    failed_status = status_route.calls[1].request.content
    assert b'"status":"FAILED"' in failed_status
    assert b'"expectedJobVersion":4' in failed_status
    assert b"OCR_FAILED: extraction pipeline error" in failed_status


@respx.mock
async def test_forwarded_receipt_workflow_enters_the_standard_ocr_pipeline():
    _, result_route = mock_happy_path()
    respx.post(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/deduplication").mock(
        return_value=Response(200, json={"decision": "no_match", "matchIds": []})
    )
    app_api = AppApiClient(base_url=APP_BASE, service_token="app-token")
    ocr = OcrReceiptActivities(
        app_api,
        FoundryClient(base_url=FOUNDRY_BASE, service_token="foundry-token"),
    )
    echo = FoundationEchoActivities(app_api)
    forwarded = JobReferenceV1(
        schemaVersion=1,
        jobId=JOB_ID,
        workflowType="ForwardedReceiptWorkflow",
        workflowId=f"forwarded-{JOB_ID}",
    )
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ForwardedReceiptWorkflow],
            activities=[
                echo.mark_running,
                ocr.ocr_get_input,
                ocr.ocr_download_receipt,
                ocr.ocr_resolve_route,
                ocr.ocr_reserve,
                ocr.ocr_mark_call_started,
                ocr.ocr_run_extraction,
                ocr.ocr_record_accepted,
                ocr.ocr_release,
                ocr.ocr_submit_extraction,
                ocr.ocr_record_deduplication,
                ocr.ocr_submit_failed,
                ocr.ocr_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            ForwardedReceiptWorkflow.run,
            forwarded,
            id=f"forwarded-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )
    assert result_route.called
    assert b'"status":"SUCCEEDED"' in result_route.calls[0].request.content
