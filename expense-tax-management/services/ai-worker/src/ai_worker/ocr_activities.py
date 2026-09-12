from __future__ import annotations

import hashlib

import httpx
from expense_contracts.generated import (
    JobReferenceV1,
    JobResultSubmitRequestV1,
    JobStatusUpdateRequestV1,
    OcrExtractionResultV1,
    OcrJobInputV1,
)
from pydantic import BaseModel
from temporalio import activity
from temporalio.exceptions import ApplicationError

from ai_worker.app_api_client import AppApiClient, DeduplicationEvidenceV1
from ai_worker.foundry_client import FoundryClient
from ai_worker.providers.fake_ocr import extract_receipt

OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1"


class OcrGetInputArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1


class OcrDownloadArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    file_id: str
    expected_sha256: str | None


class OcrResolveRouteArgs(BaseModel):
    model_config = {"extra": "forbid"}
    mode_key: str


class OcrReserveArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    tenant_id: str
    ai_model_id: str


class OcrCallStartedArgs(BaseModel):
    model_config = {"extra": "forbid"}
    reservation_id: str


class OcrRunExtractionArgs(BaseModel):
    model_config = {"extra": "forbid"}
    data: bytes


class OcrRecordAcceptedArgs(BaseModel):
    model_config = {"extra": "forbid"}
    reservation_id: str


class OcrReleaseArgs(BaseModel):
    model_config = {"extra": "forbid"}
    reservation_id: str


class OcrSubmitExtractionArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    expected_job_version: int
    extraction: OcrExtractionResultV1


class OcrRecordDeduplicationArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    source_file_id: str
    expected_job_version: int
    extraction: OcrExtractionResultV1


class OcrSubmitFailedArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    expected_job_version: int
    error: str
    message: str


class OcrMarkFailedArgs(BaseModel):
    model_config = {"extra": "forbid"}
    job_reference: JobReferenceV1
    expected_job_version: int
    message: str


class OcrReserveResult(BaseModel):
    model_config = {"extra": "forbid"}
    blocked: bool
    reservation_id: str | None


class OcrReceiptActivities:
    """OCR pipeline activities. mark_running is SHARED (same registered
    activity as FoundationEchoWorkflow's): the RUNNING transition is
    workflow-agnostic, and sharing one name avoids a duplicate type.
    """

    def __init__(
        self, app_api_client: AppApiClient, foundry_client: FoundryClient
    ) -> None:
        self._app_api_client = app_api_client
        self._foundry_client = foundry_client

    @activity.defn(name="ocr_get_input")
    async def ocr_get_input(self, args: OcrGetInputArgs) -> OcrJobInputV1:
        return await self._app_api_client.get_ocr_input(str(args.job_reference.jobId))

    @activity.defn(name="ocr_download_receipt")
    async def ocr_download_receipt(self, args: OcrDownloadArgs) -> bytes:
        data = await self._app_api_client.download_file(args.file_id)
        if args.expected_sha256 is not None:
            actual = hashlib.sha256(data).hexdigest()
            if actual != args.expected_sha256:
                raise ValueError(
                    "downloaded bytes do not match the confirmed file hash"
                )
        return data

    @activity.defn(name="ocr_resolve_route")
    async def ocr_resolve_route(self, args: OcrResolveRouteArgs) -> dict:
        return await self._foundry_client.get_effective_route(
            "RECEIPT_OCR", args.mode_key
        )

    @activity.defn(name="ocr_reserve")
    async def ocr_reserve(self, args: OcrReserveArgs) -> OcrReserveResult:
        job_id = str(args.job_reference.jobId)
        try:
            reservation = await self._foundry_client.reserve(
                args.tenant_id,
                "RECEIPT_OCR",
                args.ai_model_id,
                f"{job_id}:ocr:reserve:v1",
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 409:
                # Either quota-exhausted OR a duplicate idempotency key from
                # a lost-response retry (true disambiguation needs the
                # deferred reservation-generation mechanism). Either way the
                # honest move is to stop: clean FAILED, no spend, operator-
                # visible reservation row in the duplicate case.
                return OcrReserveResult(blocked=True, reservation_id=None)
            raise
        reservation_id = reservation.get("id")
        if not isinstance(reservation_id, str):
            raise TypeError("reserve response missing reservation id")
        return OcrReserveResult(blocked=False, reservation_id=reservation_id)

    @activity.defn(name="ocr_mark_call_started")
    async def ocr_mark_call_started(self, args: OcrCallStartedArgs) -> int:
        await self._foundry_client.mark_call_started(args.reservation_id)
        # First-ever call-started from RESERVED always creates attempt 1
        # (the transition rejects any other state, so no second attempt can
        # exist yet at this point in a fresh job's life).
        return 1

    @activity.defn(name="ocr_run_extraction")
    async def ocr_run_extraction(
        self, args: OcrRunExtractionArgs
    ) -> OcrExtractionResultV1:
        return OcrExtractionResultV1(**extract_receipt(args.data))

    @activity.defn(name="ocr_record_accepted")
    async def ocr_record_accepted(self, args: OcrRecordAcceptedArgs) -> None:
        await self._foundry_client.record_outcome(args.reservation_id, 1, "accepted")

    @activity.defn(name="ocr_release")
    async def ocr_release(self, args: OcrReleaseArgs) -> None:
        await self._foundry_client.release(args.reservation_id)

    @activity.defn(name="ocr_submit_extraction")
    async def ocr_submit_extraction(self, args: OcrSubmitExtractionArgs) -> int:
        job_id = str(args.job_reference.jobId)
        return await self._app_api_client.submit_result(
            job_id,
            JobResultSubmitRequestV1(
                schemaVersion=1,
                status="SUCCEEDED",
                idempotencyKey=f"{job_id}:ocr:result:succeeded",
                expectedJobVersion=args.expected_job_version,
                resultSchemaVersion=OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
                result=args.extraction.model_dump(mode="json", exclude_none=True),
            ),
        )

    @activity.defn(name="ocr_record_deduplication")
    async def ocr_record_deduplication(
        self, args: OcrRecordDeduplicationArgs
    ) -> dict[str, object]:
        job_id = str(args.job_reference.jobId)
        extraction = args.extraction
        try:
            return await self._app_api_client.record_deduplication_evidence(
                job_id,
                DeduplicationEvidenceV1(
                    schemaVersion=1,
                    jobId=args.job_reference.jobId,
                    sourceFileId=args.source_file_id,
                    merchant=extraction.merchant,
                    amount=extraction.amount,
                    currency=extraction.currency,
                    incurredOn=extraction.incurredOn,
                    orderNumber=extraction.orderNumber,
                    expectedJobVersion=args.expected_job_version,
                    idempotencyKey=f"{job_id}:ocr:dedup:v1",
                ),
            )
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if 400 <= status < 500 and status not in {408, 429}:
                raise ApplicationError(
                    f"Deduplication callback rejected with HTTP {status}",
                    type="DeduplicationCallbackNonRetryable",
                    non_retryable=True,
                ) from exc
            raise

    @activity.defn(name="ocr_submit_failed")
    async def ocr_submit_failed(self, args: OcrSubmitFailedArgs) -> int:
        job_id = str(args.job_reference.jobId)
        return await self._app_api_client.submit_result(
            job_id,
            JobResultSubmitRequestV1(
                schemaVersion=1,
                status="FAILED",
                idempotencyKey=f"{job_id}:ocr:result:failed",
                expectedJobVersion=args.expected_job_version,
                resultSchemaVersion=OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
                result={"error": args.error},
            ),
        )

    @activity.defn(name="ocr_mark_failed")
    async def ocr_mark_failed(self, args: OcrMarkFailedArgs) -> int:
        job_id = str(args.job_reference.jobId)
        return await self._app_api_client.update_status(
            job_id,
            JobStatusUpdateRequestV1(
                schemaVersion=1,
                status="FAILED",
                idempotencyKey=f"{job_id}:ocr:status:failed",
                expectedJobVersion=args.expected_job_version,
                message=args.message,
            ),
        )
