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
# Spec's request-boundary limit (01n-tradingagents-research-design.md §5):
# "Accept ticker strings of at most 64 characters at the request boundary."
# Distinct from and checked before upstream's own 32-char canonical limit
# (enforced separately below by safe_ticker_component) -- this one applies
# to the raw field exactly as submitted, before any trim/normalize, so a
# value padded past 64 characters with whitespace can never reach
# normalization just because trimming would shrink it back under 32.
_MAX_REQUEST_TICKER_LEN = 64


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
        if len(value) > _MAX_REQUEST_TICKER_LEN:
            raise ValueError(f"ticker exceeds {_MAX_REQUEST_TICKER_LEN} characters at the request boundary")
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


# Fields copied as-is: already fixed/validated shapes, never arbitrary
# worker/import content. ``inputs``, ``state``, and ``settings`` are handled
# separately below through their own allowlists, since those three are the
# ones a worker/import can fill with whatever it wants (ta_web/store.py's
# ``update``/``add_import`` persist them without a schema).
_PUBLIC_FIELDS = (
    "id",
    "origin",
    "status",
    "stage",
    "created_at",
    "updated_at",
    "shared",
    "artifacts_ready",
    "partial",
    "error_code",
)

# protocol.md "Public report state text fields": top-level scalar text plus
# "debate/risk textual subfields only" (the per-analyst *_history fields —
# not the raw transcript/"history", not control fields like "count" or
# "latest_speaker"). "imported_markdown" is the one field legacy imports use
# for content of unknown provenance (protocol.md).
_STATE_TEXT_FIELDS = frozenset(
    {
        "trade_date",
        "company_of_interest",
        "market_report",
        "sentiment_report",
        "news_report",
        "fundamentals_report",
        "investment_plan",
        "trader_investment_plan",
        "final_trade_decision",
        "imported_markdown",
    }
)
_STATE_DEBATE_SUBFIELDS = {
    "investment_debate_state": frozenset({"bull_history", "bear_history"}),
    "risk_debate_state": frozenset({"aggressive_history", "conservative_history", "neutral_history"}),
}

# Exact keys of upstream TradingAgentsGraph.run_settings()
# (tradingagents/graph/trading_graph.py): "version", both model/provider
# tiers, the analyst list, both round counts, and output_language — already
# an allowlist upstream ("endpoints ... keys and local paths are never
# recorded"), so this mirrors it rather than inventing new field names. The
# config also carries optional "data_vendors"/"tool_vendors" label maps; no
# task brief defines a vendor-name allowlist yet, and the known exporter/UI
# fields below are already enough to explain a run, so they're omitted here
# rather than passed through — add an explicit vendor-label/category
# allowlist later if a task needs to surface them publicly.
_SETTINGS_STR_KEYS = (
    "version",
    "llm_provider",
    "deep_think_provider",
    "deep_think_llm",
    "quick_think_provider",
    "quick_think_llm",
    "output_language",
)
_SETTINGS_INT_KEYS = ("max_debate_rounds", "max_risk_discuss_rounds")

_INPUT_KEYS = ("ticker", "analysis_date", "asset_type", "analysts", "research_depth")


def clean_state(state: dict) -> dict:
    """The public, text-only projection of a run's graph state.

    The one allowlist shared with the report pipeline (``ta_web.reports``
    re-exports this rather than duplicating the filter): only known report
    text fields and known debate/risk history subfields survive; anything
    else — raw tool messages, credentials, checkpoint/file paths a worker
    accidentally wrote — is dropped, not merely hidden by convention.
    """
    if not isinstance(state, dict):
        return {}
    cleaned = {key: state[key] for key in _STATE_TEXT_FIELDS if isinstance(state.get(key), str)}
    for parent, subfields in _STATE_DEBATE_SUBFIELDS.items():
        nested = state.get(parent)
        if not isinstance(nested, dict):
            continue
        nested_clean = {key: nested[key] for key in subfields if isinstance(nested.get(key), str)}
        if nested_clean:
            cleaned[parent] = nested_clean
    return cleaned


def safe_settings(settings: dict) -> dict:
    """The public projection of a run's settings: exactly the upstream
    ``run_settings()`` metadata fields (version, model/provider tiers,
    analysts, round counts, output language) — never vendor maps,
    credentials, endpoints, or any other key."""
    if not isinstance(settings, dict):
        return {}
    cleaned = {key: settings[key] for key in _SETTINGS_STR_KEYS if isinstance(settings.get(key), str)}
    for key in _SETTINGS_INT_KEYS:
        value = settings.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            cleaned[key] = value
    analysts = settings.get("analysts")
    if isinstance(analysts, list):
        cleaned["analysts"] = [a for a in analysts if isinstance(a, str)]
    return cleaned


def _safe_inputs(inputs: dict) -> dict:
    """The public projection of ``inputs``: exactly the known Inputs keys.

    ``Store.add_import`` persists an operator-supplied ``inputs`` dict that
    never passes through ``Inputs`` validation (legacy imports may have a
    null ``analysis_date``), so this does not validate values — it only
    drops any key/shape that isn't one of the known fields.
    """
    if not isinstance(inputs, dict):
        return dict.fromkeys(_INPUT_KEYS)
    analysts = inputs.get("analysts")
    return {
        "ticker": inputs.get("ticker") if isinstance(inputs.get("ticker"), str) else None,
        "analysis_date": inputs.get("analysis_date") if isinstance(inputs.get("analysis_date"), str) else None,
        "asset_type": inputs.get("asset_type") if isinstance(inputs.get("asset_type"), str) else None,
        "analysts": [a for a in analysts if isinstance(a, str)] if isinstance(analysts, list) else [],
        "research_depth": inputs.get("research_depth")
        if isinstance(inputs.get("research_depth"), int) and not isinstance(inputs.get("research_depth"), bool)
        else None,
    }


def public_view(run: Run, viewer: str) -> dict:
    """The fixed public shape of a run: no owner key, fingerprint, paths, or
    unsanitized worker/import content."""
    is_owner = viewer == run["owner_id"]
    can_rerun = False
    if is_owner:
        try:
            Inputs(**run["inputs"])
            can_rerun = True
        except (ValidationError, TypeError):
            can_rerun = False
    view = {key: run[key] for key in _PUBLIC_FIELDS}
    view["inputs"] = _safe_inputs(run["inputs"])
    view["state"] = clean_state(run["state"])
    view["settings"] = safe_settings(run["settings"])
    view["can_share"] = is_owner
    view["can_rerun"] = can_rerun
    return view
