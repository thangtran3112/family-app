"""The shipped contracts at runtime: `catalog.json` (`PresetCatalogV1`) and the templates it indexes.

The files live in `packages/family-desk/contracts/` in the repo and in the directory named by
`DESK_CONTRACTS_DIR` in the backend image (`backend/Dockerfile` copies `catalog.json` and
`templates/` there, 02m §b6). The seed CLI and the library endpoints read them through here.
"""

import json
import os
from pathlib import Path
from typing import Any

from ai_trading.contracts.alert_strategy import AlertStrategySpecV1
from ai_trading.contracts.strategy_spec_v1 import PresetCatalogV1

CONTRACTS_DIR_VAR = "DESK_CONTRACTS_DIR"
_REPO_CONTRACTS = Path(__file__).resolve().parents[4] / "contracts"


def contracts_dir() -> Path:
    found = Path(os.environ.get(CONTRACTS_DIR_VAR) or _REPO_CONTRACTS)
    if not (found / "catalog.json").is_file():
        raise FileNotFoundError(f"catalog.json not found in {found}; set {CONTRACTS_DIR_VAR}")
    return found


def load_catalog() -> PresetCatalogV1:
    return PresetCatalogV1.model_validate_json((contracts_dir() / "catalog.json").read_text())


def load_template(file: str) -> dict[str, Any]:
    """A template's JSON by its catalog `file` (for example `filters/gap-up.json`)."""
    return json.loads((contracts_dir() / "templates" / file).read_text())


def alert_only_spec(
    template: dict[str, Any],
    *,
    name: str | None = None,
    watchlist: str | None = None,
    channels: list[str] | None = None,
    severity: str | None = None,
) -> AlertStrategySpecV1:
    """An alert-only copy of a strategy template: no `paperOrder`, and only the alert-side limit
    (`cooldownMinutes`) kept, because the other limits describe orders. Raises `ValueError`
    (pydantic's) when the result is not a valid `AlertStrategySpecV1`."""
    spec = json.loads(json.dumps(template))  # deep copy; templates are plain JSON
    spec["then"] = {"alert": spec["then"]["alert"]}
    if "limits" in spec:
        cooldown = spec["limits"].get("cooldownMinutes")
        spec.pop("limits")
        if cooldown is not None:
            spec["limits"] = {"cooldownMinutes": cooldown}
    if name is not None:
        spec["name"] = name
    if watchlist is not None:
        spec["watch"]["universe"] = {"watchlist": watchlist}
    if channels is not None:
        spec["then"]["alert"]["channels"] = channels
    if severity is not None:
        spec["then"]["alert"]["severity"] = severity
    return AlertStrategySpecV1.model_validate(spec)
