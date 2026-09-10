"""Injectable Clerk M2M JWT acquisition and in-memory reuse."""

from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Protocol

import httpx


class M2MTokenError(RuntimeError):
    """Raised when Clerk cannot provide a usable M2M token."""


class TokenIssuer(Protocol):
    async def issue(self) -> str: ...


def _decode_payload(token: str) -> Mapping[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise M2MTokenError("Clerk M2M response was not a JWT")
    try:
        padding = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
    except (ValueError, TypeError, binascii.Error, json.JSONDecodeError) as error:
        raise M2MTokenError("Clerk M2M response contained an invalid JWT") from error
    if not isinstance(payload, dict):
        raise M2MTokenError("Clerk M2M response contained an invalid JWT payload")
    return payload


def _validate_token(
    token: str,
    *,
    audience: str,
    scopes: Sequence[str],
    client_id: str,
    now: float,
) -> float:
    payload = _decode_payload(token)
    if payload.get("aud") != audience:
        raise M2MTokenError("Clerk M2M token has wrong audience")

    scope_claim = payload.get("scope")
    token_scopes = scope_claim.split() if isinstance(scope_claim, str) else []
    if any(scope not in token_scopes for scope in scopes):
        raise M2MTokenError("Clerk M2M token is missing required scope")

    token_client_id = payload.get("client_id", payload.get("azp"))
    if token_client_id != client_id:
        raise M2MTokenError("Clerk M2M token has wrong client identity")

    expiry = payload.get("exp")
    if (
        not isinstance(expiry, (int, float))
        or isinstance(expiry, bool)
        or expiry <= now
    ):
        raise M2MTokenError("Clerk M2M token is expired or has invalid expiry")
    return float(expiry)


class ClerkM2MTokenIssuer:
    """Mint one short-lived JWT from Clerk using a machine secret."""

    def __init__(
        self,
        *,
        machine_secret_key: str,
        audience: str,
        scopes: Sequence[str],
        client_id: str = "ai-worker",
        ttl_seconds: int = 300,
        timeout_seconds: float = 5,
        endpoint: str = "https://api.clerk.com/v1/m2m_tokens",
        client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
        now: Callable[[], float] = time.time,
    ) -> None:
        if not machine_secret_key.strip():
            raise M2MTokenError("Clerk machine secret is required")
        if ttl_seconds <= 0:
            raise ValueError("Clerk M2M token TTL must be positive")
        self._machine_secret_key = machine_secret_key
        self._audience = audience
        self._scopes = tuple(scopes)
        self._client_id = client_id
        self._ttl_seconds = ttl_seconds
        self._timeout_seconds = timeout_seconds
        self._endpoint = endpoint
        self._client_factory = client_factory
        self._now = now

    async def issue(self) -> str:
        try:
            async with self._client_factory(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    self._endpoint,
                    params={
                        "token_format": "jwt",
                        "seconds_until_expiration": str(self._ttl_seconds),
                    },
                    headers={"Authorization": f"Bearer {self._machine_secret_key}"},
                    json={
                        "claims": {
                            "aud": self._audience,
                            "scope": " ".join(self._scopes),
                        }
                    },
                )
                response.raise_for_status()
                body = response.json()
                token = body.get("token") if isinstance(body, dict) else None
                if not isinstance(token, str) or not token:
                    raise M2MTokenError("Clerk M2M response did not contain a token")
                _validate_token(
                    token,
                    audience=self._audience,
                    scopes=self._scopes,
                    client_id=self._client_id,
                    now=self._now(),
                )
                return token
        except M2MTokenError:
            raise
        except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError) as error:
            raise M2MTokenError("Clerk M2M token acquisition failed") from error


class CachedM2MTokenProvider:
    """Reuse a token in process, refreshing before its expiry."""

    def __init__(
        self,
        issuer: Callable[[], Awaitable[str]],
        *,
        audience: str,
        scopes: Sequence[str],
        client_id: str = "ai-worker",
        refresh_skew_seconds: int = 30,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._issuer = issuer
        self._audience = audience
        self._scopes = tuple(scopes)
        self._client_id = client_id
        self._refresh_skew_seconds = refresh_skew_seconds
        self._now = now
        self._token: str | None = None
        self._expires_at = 0.0

    async def get_token(self) -> str:
        if (
            self._token is not None
            and self._expires_at - self._refresh_skew_seconds > self._now()
        ):
            return self._token

        token = await self._issuer()
        expires_at = _validate_token(
            token,
            audience=self._audience,
            scopes=self._scopes,
            client_id=self._client_id,
            now=self._now(),
        )
        self._token = token
        self._expires_at = expires_at
        return token
