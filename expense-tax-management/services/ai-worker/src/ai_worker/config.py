"""Typed environment configuration for ai-worker."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class ClerkConfig:
    issuer_url: str
    jwks_url: str
    tenant_audience: str
    platform_audience: str
    app_service_audience: str
    foundry_service_audience: str
    machine_secret_key: str
    publishable_key: str | None = None
    secret_key: str | None = None
    webhook_signing_secret: str | None = None

    def __repr__(self) -> str:
        return (
            "ClerkConfig("
            f"issuer_url={self.issuer_url!r}, "
            f"jwks_url={self.jwks_url!r}, "
            f"tenant_audience={self.tenant_audience!r}, "
            f"platform_audience={self.platform_audience!r}, "
            f"app_service_audience={self.app_service_audience!r}, "
            f"foundry_service_audience={self.foundry_service_audience!r}, "
            "publishable_key=<redacted>, secret_key=<redacted>, "
            "webhook_signing_secret=<redacted>)"
        )


@dataclass(frozen=True)
class WorkerConfig:
    clerk: ClerkConfig


def _required(env: Mapping[str, str | None], key: str) -> str:
    value = (env.get(key) or "").strip()
    if not value:
        raise ValueError(f"Missing required environment variable: {key}")
    return value


def _url(env: Mapping[str, str | None], key: str) -> str:
    value = _required(env, key)
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError(f"Invalid URL in environment variable: {key}")
    return value


def _optional(env: Mapping[str, str | None], key: str) -> str | None:
    value = (env.get(key) or "").strip()
    return value or None


def worker_config_from_env(
    env: Mapping[str, str | None] | None = None,
) -> WorkerConfig:
    values = os.environ if env is None else env
    return WorkerConfig(
        clerk=ClerkConfig(
            issuer_url=_url(values, "CLERK_ISSUER_URL"),
            jwks_url=_url(values, "CLERK_JWKS_URL"),
            tenant_audience=_required(values, "CLERK_TENANT_AUDIENCE"),
            platform_audience=_required(values, "CLERK_PLATFORM_AUDIENCE"),
            app_service_audience=_required(values, "CLERK_APP_SERVICE_AUDIENCE"),
            foundry_service_audience=_required(
                values, "CLERK_FOUNDRY_SERVICE_AUDIENCE"
            ),
            machine_secret_key=_required(values, "CLERK_MACHINE_SECRET_KEY"),
            publishable_key=_optional(values, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
            secret_key=_optional(values, "CLERK_SECRET_KEY"),
            webhook_signing_secret=_optional(values, "CLERK_WEBHOOK_SIGNING_SECRET"),
        )
    )
