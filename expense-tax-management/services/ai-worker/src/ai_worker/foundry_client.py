"""Thin HTTP client for the Foundry service-scoped internal routes."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from ai_worker.auth.client import CachedM2MTokenProvider, ClerkM2MTokenIssuer

TokenProvider = Callable[[], Awaitable[str]]


class FoundryClient:
    def __init__(
        self,
        base_url: str,
        service_token: str | None = None,
        token_provider: TokenProvider | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._token_provider = token_provider

    async def _headers(self) -> dict[str, str]:
        token = (
            await self._token_provider()
            if self._token_provider is not None
            else self._service_token
        )
        if not token:
            raise RuntimeError("Foundry service token provider is required")
        return {"Authorization": f"Bearer {token}"}

    async def get_effective_route(
        self, operation: str, mode_key: str
    ) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/internal/v1/effective-route",
                params={"operation": operation, "modeKey": mode_key},
                headers=await self._headers(),
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
                headers=await self._headers(),
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
                headers=await self._headers(),
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
                headers=await self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data

    async def release(self, reservation_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/ai-quota-reservations/{reservation_id}/release",
                headers=await self._headers(),
            )
            response.raise_for_status()
            data = response.json()
            assert isinstance(data, dict)
            return data


def foundry_client_from_env() -> FoundryClient:
    base_url = os.environ["FOUNDRY_BASE_URL"]
    audience = os.environ["CLERK_FOUNDRY_SERVICE_AUDIENCE"]
    scopes = ("routes:read", "reservations:write")
    issuer = ClerkM2MTokenIssuer(
        machine_secret_key=os.environ["CLERK_FOUNDRY_MACHINE_SECRET_KEY"],
        audience=audience,
        scopes=scopes,
        source_machine_id=os.environ["CLERK_FOUNDRY_SERVICE_SUBJECT"],
    )
    provider = CachedM2MTokenProvider(
        issuer.issue,
        audience=audience,
        scopes=scopes,
        source_machine_id=os.environ["CLERK_FOUNDRY_SERVICE_SUBJECT"],
    )
    return FoundryClient(base_url=base_url, token_provider=provider.get_token)
