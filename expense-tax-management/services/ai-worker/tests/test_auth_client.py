import base64
import json

import httpx
import pytest

from ai_worker.auth.client import (
    CachedM2MTokenProvider,
    ClerkM2MTokenIssuer,
    M2MTokenError,
)


def jwt_with_claims(claims: dict[str, object]) -> str:
    def encode(value: object) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{encode({'alg': 'RS256', 'typ': 'JWT'})}.{encode(claims)}.signature"


@pytest.fixture
def valid_token() -> str:
    return jwt_with_claims(
        {
            "aud": "expense-services",
            "scope": "jobs:write files:read",
            "azp": "ai-worker",
            "exp": 1_000,
        }
    )


async def test_issuer_creates_short_lived_jwt_with_machine_secret(valid_token):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"token": valid_token})

    transport = httpx.MockTransport(handler)
    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="expense-services",
        scopes=("jobs:write", "files:read"),
        ttl_seconds=300,
        timeout_seconds=2,
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=transport, **kwargs
        ),
        now=lambda: 900,
    )

    assert await issuer.issue() == valid_token
    assert requests[0].headers["authorization"] == "Bearer ak_test_secret"
    assert requests[0].url.params["token_format"] == "jwt"
    assert requests[0].url.params["seconds_until_expiration"] == "300"
    assert json.loads(requests[0].content) == {
        "claims": {"aud": "expense-services", "scope": "jobs:write files:read"}
    }


async def test_provider_reuses_cached_token_until_refresh_window(valid_token):
    calls = 0

    async def issue() -> str:
        nonlocal calls
        calls += 1
        return valid_token

    provider = CachedM2MTokenProvider(
        issue,
        audience="expense-services",
        scopes=("jobs:write", "files:read"),
        refresh_skew_seconds=50,
        now=lambda: 900,
    )

    assert await provider.get_token() == valid_token
    assert await provider.get_token() == valid_token
    assert calls == 1


async def test_provider_refreshes_token_inside_expiry_window():
    tokens = [
        jwt_with_claims({"aud": "expense-services", "scope": "jobs:write", "azp": "ai-worker", "exp": 100}),
        jwt_with_claims({"aud": "expense-services", "scope": "jobs:write", "azp": "ai-worker", "exp": 200}),
    ]
    now = 60

    async def issue() -> str:
        return tokens.pop(0)

    provider = CachedM2MTokenProvider(
        issue,
        audience="expense-services",
        scopes=("jobs:write",),
        refresh_skew_seconds=50,
        now=lambda: now,
    )

    first = await provider.get_token()
    now = 70
    second = await provider.get_token()

    assert first != second


@pytest.mark.parametrize(
    "claims, message",
    [
        (
            {"aud": "wrong-audience", "scope": "jobs:write", "azp": "ai-worker", "exp": 1_000},
            "audience",
        ),
        (
            {"aud": "expense-services", "scope": "other:scope", "azp": "ai-worker", "exp": 1_000},
            "scope",
        ),
        (
            {"aud": "expense-services", "scope": "jobs:write", "azp": "ai-worker", "exp": 800},
            "expired",
        ),
        (
            {"aud": "expense-services", "scope": "jobs:write", "exp": 1_000},
            "client identity",
        ),
        (
            {"aud": "expense-services", "scope": "jobs:write", "azp": "other-service", "exp": 1_000},
            "client identity",
        ),
    ],
)
async def test_issuer_rejects_invalid_claims(claims, message):
    token = jwt_with_claims(claims)

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": token})

    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="expense-services",
        scopes=("jobs:write",),
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        ),
        now=lambda: 900,
    )

    with pytest.raises(M2MTokenError, match=message):
        await issuer.issue()


async def test_issuer_accepts_clerk_m2m_worker_identity_from_client_id():
    token = jwt_with_claims(
        {
            "aud": "expense-services",
            "scope": "jobs:write",
            "client_id": "ai-worker",
            "exp": 1_000,
        }
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": token})

    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="expense-services",
        scopes=("jobs:write",),
        client_id="ai-worker",
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        ),
        now=lambda: 900,
    )

    assert await issuer.issue() == token


async def test_issuer_requires_machine_secret_without_logging_it():
    with pytest.raises(M2MTokenError, match="machine secret") as raised:
        ClerkM2MTokenIssuer(
            machine_secret_key=" ",
            audience="expense-services",
            scopes=("jobs:write",),
        )

    assert "ak_test" not in str(raised.value)
