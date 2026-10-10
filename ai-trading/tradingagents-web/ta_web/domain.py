"""Domain model for the TradingAgents research web wrapper.

Reuses upstream TradingAgents validation/normalization instead of
re-implementing it: ``normalize_symbol``/``safe_ticker_component`` (path-safe
canonical symbols) and ``AssetType``/``AnalystType``/``filter_analysts_for_asset_type``
(asset-aware analyst compatibility). All new code here belongs to this wrapper
package; nothing in ``packages/trading-agents`` is modified.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime
from typing import Literal, TypedDict

from cli.models import AnalystType, AssetType
from cli.prompts import filter_analysts_for_asset_type
from pydantic import (
    BaseModel,
    ConfigDict,
    ValidationError,
    field_validator,
    model_validator,
)
from tradingagents.dataflows.symbols import normalize_symbol, safe_ticker_component

# "sentiment" is the user-facing label; the wire/analyst key is "social".
_ANALYST_ALIASES = {"sentiment": "social"}
_MIN_DEPTH, _MAX_DEPTH = 1, 5


class Inputs(BaseModel):
    """A validated, admission-ready research request."""

    model_config = ConfigDict(extra="forbid")

    ticker: str
    analysis_date: str
    asset_type: Literal["stock", "crypto"]
    analysts: list[str]
    research_depth: int | None = None

    @field_validator("research_depth", mode="before")
    @classmethod
    def _check_depth(cls, value):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            # Pydantic validators must raise ValueError (not TypeError) to be
            # wrapped as a ValidationError.
            raise ValueError("research_depth must be an integer")  # noqa: TRY004
        if not (_MIN_DEPTH <= value <= _MAX_DEPTH):
            raise ValueError(f"research_depth must be between {_MIN_DEPTH} and {_MAX_DEPTH}")
        return value

    @field_validator("ticker")
    @classmethod
    def _check_ticker(cls, value: str) -> str:
        canonical = normalize_symbol(value.strip())
        try:
            return safe_ticker_component(canonical)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("analysis_date")
    @classmethod
    def _check_analysis_date(cls, value: str) -> str:
        raw = value.strip()
        try:
            parsed = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError("analysis_date must be YYYY-MM-DD") from None
        if parsed.strftime("%Y-%m-%d") != raw:
            raise ValueError("analysis_date must be canonical YYYY-MM-DD")
        if parsed > date.today():
            raise ValueError("analysis_date must not be in the future")
        return raw

    @model_validator(mode="after")
    def _check_analysts(self) -> Inputs:
        asset = AssetType(self.asset_type)
        known = {a.value: a for a in AnalystType}
        ordered: list[AnalystType] = []
        for raw in self.analysts:
            name = _ANALYST_ALIASES.get(str(raw).strip().lower(), str(raw).strip().lower())
            analyst = known.get(name)
            if analyst is None:
                raise ValueError(f"unknown analyst: {raw!r}")
            if analyst not in ordered:
                ordered.append(analyst)
        if not ordered:
            raise ValueError("name at least one analyst")
        available = filter_analysts_for_asset_type(list(AnalystType), asset)
        unavailable = [a.value for a in ordered if a not in available]
        if unavailable:
            raise ValueError(f"analyst not available for {asset.value}: {unavailable}")
        self.analysts = [a.value for a in available if a in ordered]
        return self


class Run(TypedDict):
    """A persisted research record. Inputs/state/settings are JSON-safe dicts."""

    id: str
    owner_id: str
    inputs: dict
    origin: str
    status: str
    stage: str | None
    created_at: str
    updated_at: str
    shared: bool
    state: dict
    settings: dict
    artifacts_ready: bool
    partial: bool
    fingerprint: str | None
    error_code: str | None


class NotFoundError(Exception):
    """Raised for an absent or unavailable run id. Carries no resource/identity details."""


class BusyError(Exception):
    """Raised when another research run is already active."""


def owner_key(identity: str) -> str:
    """Normalize a verified identity to an opaque SHA-256 hex owner key."""
    value = identity.strip().lower()
    if not value or len(value) > 1024:
        raise ValueError("INVALID_IDENTITY")
    return hashlib.sha256(value.encode()).hexdigest()


_PUBLIC_FIELDS = (
    "id",
    "inputs",
    "origin",
    "status",
    "stage",
    "created_at",
    "updated_at",
    "shared",
    "state",
    "settings",
    "artifacts_ready",
    "partial",
    "error_code",
)


def public_view(run: Run, viewer: str) -> dict:
    """The fixed public shape of a run: no owner key, fingerprint, or paths."""
    is_owner = viewer == run["owner_id"]
    can_rerun = False
    if is_owner:
        try:
            Inputs(**run["inputs"])
            can_rerun = True
        except (ValidationError, TypeError):
            can_rerun = False
    view = {key: run[key] for key in _PUBLIC_FIELDS}
    view["can_share"] = is_owner
    view["can_rerun"] = can_rerun
    return view
