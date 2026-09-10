import uuid

import respx
from expense_contracts.generated import JobStatusUpdateRequestV1
from httpx import Response

from ai_worker.app_api_client import AppApiClient
from ai_worker.foundry_client import FoundryClient


async def test_app_api_client_injects_token_provider():
    token_calls = 0

    async def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "app-token"

    job_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
    request = JobStatusUpdateRequestV1(
        schemaVersion=1,
        status="RUNNING",
        expectedJobVersion=1,
        idempotencyKey="key",
    )

    with respx.mock:
        route = respx.post(f"http://app.test/internal/v1/jobs/{job_id}/status").mock(
            return_value=Response(200, json={"version": 2})
        )
        client = AppApiClient(
            base_url="http://app.test",
            token_provider=token_provider,
        )
        assert await client.update_status(str(job_id), request) == 2

    assert token_calls == 1
    assert route.calls[0].request.headers["authorization"] == "Bearer app-token"


async def test_foundry_client_injects_token_provider():
    async def token_provider() -> str:
        return "foundry-token"

    with respx.mock:
        route = respx.get("http://foundry.test/internal/v1/effective-route").mock(
            return_value=Response(200, json={"route": "fake"})
        )
        client = FoundryClient(
            base_url="http://foundry.test",
            token_provider=token_provider,
        )
        assert await client.get_effective_route("ocr", "default") == {"route": "fake"}

    assert route.calls[0].request.headers["authorization"] == "Bearer foundry-token"
