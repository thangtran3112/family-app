import hashlib
import uuid

import respx
from expense_contracts.generated import JobReferenceV1, OcrExtractionResultV1
from httpx import Response
from temporalio.testing import ActivityEnvironment

from ai_worker.app_api_client import AppApiClient
from ai_worker.foundry_client import FoundryClient
from ai_worker.ocr_activities import (
    OcrCallStartedArgs,
    OcrDownloadArgs,
    OcrGetInputArgs,
    OcrMarkFailedArgs,
    OcrReceiptActivities,
    OcrRecordAcceptedArgs,
    OcrRecordDeduplicationArgs,
    OcrReleaseArgs,
    OcrReserveArgs,
    OcrRunExtractionArgs,
    OcrSubmitExtractionArgs,
    OcrSubmitFailedArgs,
)

JOB_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")
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


def activities() -> OcrReceiptActivities:
    return OcrReceiptActivities(
        AppApiClient(base_url=APP_BASE, service_token="app-token"),
        FoundryClient(base_url=FOUNDRY_BASE, service_token="foundry-token"),
    )


@respx.mock
async def test_ocr_get_input_returns_the_server_bound_binding():
    route = respx.get(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/ocr-input").mock(
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
    env = ActivityEnvironment()
    result = await env.run(
        activities().ocr_get_input, OcrGetInputArgs(job_reference=job_reference())
    )

    assert route.called
    assert result.fileId == FILE_ID
    assert str(result.tenantId) == str(TENANT_ID)


@respx.mock
async def test_ocr_download_receipt_verifies_the_confirmed_hash():
    respx.post(f"{APP_BASE}/internal/v1/files/{FILE_ID}/read-url").mock(
        return_value=Response(
            200,
            json={
                "url": f"{APP_BASE}/signed-bytes",
                "expiresAt": "2026-09-09T00:00:00.000Z",
            },
        )
    )
    respx.get(f"{APP_BASE}/signed-bytes").mock(
        return_value=Response(200, content=RECEIPT_BYTES)
    )
    env = ActivityEnvironment()

    data = await env.run(
        activities().ocr_download_receipt,
        OcrDownloadArgs(
            job_reference=job_reference(),
            file_id=str(FILE_ID),
            expected_sha256=RECEIPT_SHA,
        ),
    )
    assert data == RECEIPT_BYTES

    # Tampered bytes fail loudly instead of flowing into extraction.
    respx.get(f"{APP_BASE}/signed-bytes").mock(
        return_value=Response(200, content=b"tampered")
    )
    try:
        await env.run(
            activities().ocr_download_receipt,
            OcrDownloadArgs(
                job_reference=job_reference(),
                file_id=str(FILE_ID),
                expected_sha256=RECEIPT_SHA,
            ),
        )
        raise AssertionError("expected a hash mismatch failure")
    except ValueError as exc:
        assert "hash" in str(exc)


@respx.mock
async def test_ocr_reserve_maps_409_to_blocked_and_passes_through_success():
    route = respx.post(f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations").mock(
        return_value=Response(
            200, json={"id": str(RESERVATION_ID), "status": "RESERVED"}
        )
    )
    env = ActivityEnvironment()
    result = await env.run(
        activities().ocr_reserve,
        OcrReserveArgs(
            job_reference=job_reference(),
            tenant_id=str(TENANT_ID),
            ai_model_id=str(MODEL_ID),
        ),
    )
    assert result.blocked is False
    assert result.reservation_id == str(RESERVATION_ID)
    sent = route.calls[0].request.content
    assert b'"operation":"RECEIPT_OCR"' in sent
    assert f'"idempotencyKey":"{JOB_ID}:ocr:reserve:v1"'.encode() in sent

    respx.post(f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations").mock(
        return_value=Response(409, json={"error": {"code": "CONFLICT"}})
    )
    blocked = await env.run(
        activities().ocr_reserve,
        OcrReserveArgs(
            job_reference=job_reference(),
            tenant_id=str(TENANT_ID),
            ai_model_id=str(MODEL_ID),
        ),
    )
    assert blocked.blocked is True
    assert blocked.reservation_id is None


@respx.mock
async def test_ocr_full_happy_path_posts_version_chained_callbacks():
    respx.post(
        f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations/{RESERVATION_ID}/call-started"
    ).mock(return_value=Response(200, json={"id": str(RESERVATION_ID)}))
    respx.post(
        f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations/{RESERVATION_ID}/attempts/1/outcome"
    ).mock(return_value=Response(200, json={"id": str(RESERVATION_ID)}))
    respx.post(
        f"{FOUNDRY_BASE}/internal/v1/ai-quota-reservations/{RESERVATION_ID}/release"
    ).mock(return_value=Response(200, json={"id": str(RESERVATION_ID)}))
    status_route = respx.post(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 4})
    )
    result_route = respx.post(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/result").mock(
        return_value=Response(200, json={"version": 5})
    )
    env = ActivityEnvironment()
    acts = activities()

    attempt = await env.run(
        acts.ocr_mark_call_started,
        OcrCallStartedArgs(reservation_id=str(RESERVATION_ID)),
    )
    assert attempt == 1

    extraction = await env.run(
        acts.ocr_run_extraction, OcrRunExtractionArgs(data=RECEIPT_BYTES)
    )
    assert isinstance(extraction, OcrExtractionResultV1)
    assert extraction.merchant == "Fake OCR Merchant"

    await env.run(
        acts.ocr_record_accepted,
        OcrRecordAcceptedArgs(reservation_id=str(RESERVATION_ID)),
    )
    await env.run(acts.ocr_release, OcrReleaseArgs(reservation_id=str(RESERVATION_ID)))

    version = await env.run(
        acts.ocr_submit_extraction,
        OcrSubmitExtractionArgs(
            job_reference=job_reference(), expected_job_version=3, extraction=extraction
        ),
    )
    assert version == 5
    sent = result_route.calls[0].request.content
    assert b'"status":"SUCCEEDED"' in sent
    assert b'"resultSchemaVersion":"ocr-extraction-v1"' in sent
    assert b'"expectedJobVersion":3' in sent
    # Optional extraction fields stay absent, never null (0L lesson).
    assert b'"notes"' not in sent

    failed_version = await env.run(
        acts.ocr_submit_failed,
        OcrSubmitFailedArgs(
            job_reference=job_reference(),
            expected_job_version=5,
            error="QUOTA_BLOCKED",
            message="QUOTA_BLOCKED: exhausted",
        ),
    )
    assert failed_version == 5
    failed_sent = result_route.calls[1].request.content
    assert b'"status":"FAILED"' in failed_sent
    assert b'"error":"QUOTA_BLOCKED"' in failed_sent

    await env.run(
        acts.ocr_mark_failed,
        OcrMarkFailedArgs(
            job_reference=job_reference(),
            expected_job_version=5,
            message="OCR_FAILED: x",
        ),
    )
    assert status_route.called


@respx.mock
async def test_ocr_record_deduplication_sends_only_job_bound_ocr_evidence():
    route = respx.post(f"{APP_BASE}/internal/v1/jobs/{JOB_ID}/deduplication").mock(
        return_value=Response(200, json={"decision": "no_match", "matchIds": []})
    )
    extraction = OcrExtractionResultV1(
        schemaVersion=1,
        merchant="Cafe",
        amount="12.30",
        currency="USD",
        incurredOn="2026-09-11",
        confidence=0.99,
    )

    result = await ActivityEnvironment().run(
        activities().ocr_record_deduplication,
        OcrRecordDeduplicationArgs(
            job_reference=job_reference(),
            source_file_id=str(FILE_ID),
            expected_job_version=5,
            extraction=extraction,
        ),
    )

    assert result == {"decision": "no_match", "matchIds": []}
    sent = route.calls[0].request.content
    assert b'"jobId":"33333333-3333-4333-8333-333333333333"' in sent
    assert b'"sourceFileId":"44444444-4444-4444-8444-444444444444"' in sent
    assert b'"expectedJobVersion":5' in sent
    assert (
        b'"idempotencyKey":"33333333-3333-4333-8333-333333333333:ocr:dedup:v1"' in sent
    )
    assert b'"tenantId"' not in sent
    assert b'"personalProfileId"' not in sent
    assert b'"businessId"' not in sent
    assert b'"existingExpenseId"' not in sent
