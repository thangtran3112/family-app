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
                json=request.model_dump(mode="json"),
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
                json=request.model_dump(mode="json"),
                headers={"Authorization": f"Bearer {self._service_token}"},
            )
            response.raise_for_status()
            return int(response.json()["version"])


def app_api_client_from_env() -> AppApiClient:
    base_url = os.environ["APP_API_BASE_URL"]
    service_token = os.environ["APP_API_SERVICE_TOKEN"]
    return AppApiClient(base_url=base_url, service_token=service_token)
