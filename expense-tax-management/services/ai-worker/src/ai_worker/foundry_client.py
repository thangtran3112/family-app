"""Thin HTTP client for the Foundry service-scoped internal routes.

Same bearer-token discipline as AppApiClient: the worker is handed a plain
token string (FOUNDRY_SERVICE_TOKEN), it never mints one. Catalog shapes
(provider/model/route) intentionally have no Pydantic models in
expense_contracts -- they never cross the Temporal boundary, so the worker
reads the small fields it needs straight off the JSON.

App-signed admission grants (design doc section 16.3) are NOT implemented:
the worker passes the App API-resolved tenantId through, and tampering
with it requires worker-token compromise. Tracked as pre-release
hardening; see phase-0c-ocr-pipeline-implementation.md.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


class FoundryClient:
    def __init__(self, base_url: str, service_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._service_token}"}

    async def get_effective_route(
        self, operation: str, mode_key: str
    ) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/internal/v1/effective-route",
                params={"operation": operation, "modeKey": mode_key},
                headers=self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data

    async def reserve(
        self,
        tenant_id: str,
        operation: str,
        ai_model_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/ai-quota-reservations",
                json={
                    "tenantId": tenant_id,
                    "operation": operation,
                    "aiModelId": ai_model_id,
                    "idempotencyKey": idempotency_key,
                },
                headers=self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data

    async def mark_call_started(
        self, reservation_id: str, provider_idempotency_key: str | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if provider_idempotency_key is not None:
            body["providerIdempotencyKey"] = provider_idempotency_key
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/ai-quota-reservations/{reservation_id}/call-started",
                json=body,
                headers=self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data

    async def record_outcome(
        self,
        reservation_id: str,
        attempt_number: int,
        outcome: str,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/ai-quota-reservations/{reservation_id}/attempts/{attempt_number}/outcome",
                json={"outcome": outcome},
                headers=self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data

    async def release(self, reservation_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/ai-quota-reservations/{reservation_id}/release",
                headers=self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data


def foundry_client_from_env() -> FoundryClient:
    base_url = os.environ["FOUNDRY_BASE_URL"]
    service_token = os.environ["FOUNDRY_SERVICE_TOKEN"]
    return FoundryClient(base_url=base_url, service_token=service_token)
