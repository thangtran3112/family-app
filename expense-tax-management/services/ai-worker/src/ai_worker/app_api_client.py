"""Thin HTTP client for the App API worker-callback routes.

The worker is handed a plain bearer-token string by whatever process
starts it (APP_API_SERVICE_TOKEN) -- it does not mint or sign a JWT
itself. Short-lived App-signed admission grants for Foundry quota
reservation (design doc section 16.3) are a Phase 0C concern once the
worker actually needs to reserve AI usage; this foundation phase never
talks to Foundry.
"""

from __future__ import annotations

import os

import httpx
from expense_contracts.generated import (
    JobResultSubmitRequestV1,
    JobStatusUpdateRequestV1,
    OcrJobInputV1,
)


class AppApiClient:
    def __init__(self, base_url: str, service_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token

    async def update_status(
        self, job_id: str, request: JobStatusUpdateRequestV1
    ) -> int:
        """Returns the ProcessingJob's new version so the caller can chain
        the next callback's expectedJobVersion without a separate read
        (the worker has no GET-job scope, only write scopes)."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/jobs/{job_id}/status",
                # exclude_none: Pydantic serializes an unset Optional field as
                # explicit JSON `null`; the Zod contract's `.optional()` only
                # accepts an *absent* key, not `null` (it would need
                # `.nullable()` too for that) -- omitting None fields entirely
                # is what actually round-trips against a z.strictObject with
                # plain `.optional()` fields.
                json=request.model_dump(mode="json", exclude_none=True),
                headers={"Authorization": f"Bearer {self._service_token}"},
            )
            response.raise_for_status()
            return int(response.json()["version"])

    async def submit_result(
        self, job_id: str, request: JobResultSubmitRequestV1
    ) -> int:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/jobs/{job_id}/result",
                json=request.model_dump(mode="json", exclude_none=True),
                headers={"Authorization": f"Bearer {self._service_token}"},
            )
            response.raise_for_status()
            return int(response.json()["version"])

    async def get_ocr_input(self, job_id: str) -> OcrJobInputV1:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/internal/v1/jobs/{job_id}/ocr-input",
                headers={"Authorization": f"Bearer {self._service_token}"},
            )
            response.raise_for_status()
            return OcrJobInputV1(**response.json())

    async def issue_file_read_url(self, file_id: str) -> str:
        """Worker read-url route returns a bearer-free signed URL; the
        caller GETs it separately (kept as two steps so tests can assert
        each hop)."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/files/{file_id}/read-url",
                headers={"Authorization": f"Bearer {self._service_token}"},
            )
            response.raise_for_status()
            return str(response.json()["url"])

    async def download_file(self, file_id: str) -> bytes:
        """Resolve the worker read URL for a file, then fetch its bytes.

        Callers pass the file id threaded out of the job-bound ocr-input
        response (server-resolved binding), never a client-supplied value.
        """
        url = await self.issue_file_read_url(file_id)
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.content


def app_api_client_from_env() -> AppApiClient:
    base_url = os.environ["APP_API_BASE_URL"]
    service_token = os.environ["APP_API_SERVICE_TOKEN"]
    return AppApiClient(base_url=base_url, service_token=service_token)
