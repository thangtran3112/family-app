"""Strategy on replay (02o decision 4): `core.evaluate.evaluate` runs once per session over the replay day plus
its lookback, and the playhead releases each would-fire signal when its bar closes. Read-only: nothing here
writes `signals`, `alerts`, or the outbox (a test asserts the tables are unchanged).

Wrapper rules, applied here and not in the engine:
- `then.alert.frequency: "once"` is applied inside the window (the engine's own `once` would count lookback days);
- `expiresOn` is ignored (replay tests the rule, not its schedule), and `message` and `channels` are ignored;
- a filter arms as an in-memory `StrategySpecV1` for the replay symbol (never saved): its `watch.session`,
  `watch.runOn`, and `when`; liquidity, universe, `rank` and `maxResults` do not apply to one symbol;
- no cooldown (`limits.cooldownMinutes`): replay lists every rising edge in the window;
- armed versions are snapshotted (`version_id`), so editing a strategy later never changes an old session.

The engine is causal (closed bars only, rising edges per day), so releasing a full-window evaluation by the
playhead equals evaluating at each moment: `tests/replay/test_replay_signals.py` pins that (prefix consistency).
"""

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import bar_close
from ai_trading.alerts.service import StrategyNotFound, get_strategy
from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import ET
from ai_trading.core.evaluate import INTRADAY_CADENCES, check, evaluate
from ai_trading.db.models import FilterStrategy, FilterStrategyVersion
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.mvp_stub import alerts as mvp_alerts
from ai_trading.mvp_stub import stub_enabled as mvp_stub_enabled
from ai_trading.mvp_stub import world as mvp_world
from ai_trading.replay.model import Fire

log = logging.getLogger(__name__)

MINUTE = pd.Timedelta(minutes=1)


class ArmProblem(Exception):
    """An armed reference the session cannot use. `index` is its position in `armed`."""

    def __init__(self, index: int, message: str) -> None:
        super().__init__(message)
        self.index = index
        self.message = message


@dataclass(frozen=True)
class Armed:
    source: str  # "alert_strategy" | "filter"
    id: int
    version_id: int
    name: str
    bias: str | None
    spec: dict[str, Any]  # a StrategySpecV1 for the replay symbol, in stored (dumped) form

    def ref(self) -> dict[str, Any]:
        """What the session row keeps: a reference, never the spec (the version is the snapshot)."""
        return {
            "source": self.source,
            "id": self.id,
            "version_id": self.version_id,
            "name": self.name,
            "bias": self.bias,
        }


def _bias_by_label() -> dict[str, str]:
    try:
        return {entry.label: entry.bias for entry in load_catalog().entries}
    except FileNotFoundError:
        return {}


def _replay_spec(spec: dict[str, Any], symbol: str) -> StrategySpecV1:
    """This symbol as the source, `once` and `expiresOn` removed (applied in the window / ignored), no cooldown."""
    alert = {
        k: v
        for k, v in spec["then"]["alert"].items()
        if k not in ("expiresOn", "message") and not (k == "frequency" and v == "once")
    }
    body = {k: v for k, v in spec.items() if k != "limits"}
    return StrategySpecV1.model_validate(
        {**body, "watch": {**spec["watch"], "universe": {"symbols": [symbol]}}, "then": {"alert": alert}}
    )


def _filter_as_spec(name: str, spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "name": name,
        "watch": {
            "universe": {"symbols": ["X"]},  # replaced per replay symbol by `_replay_spec`
            "session": spec["watch"]["session"],
            "runOn": spec["watch"]["runOn"],
        },
        "when": spec["when"],
        "then": {"alert": {"channels": ["inbox"], "frequency": "every_time"}},
    }


def resolve(db: Session, user_id: int, refs: list[dict[str, Any]], symbol: str) -> list[Armed]:
    """The armed strategies of a session, versions snapshotted. Raises `ArmProblem` for a reference that is not
    hers or not runnable (the engine gate `core.evaluate.check`)."""
    bias = _bias_by_label()
    out: list[Armed] = []
    for index, ref in enumerate(refs):
        if ref["source"] == "alert_strategy":
            try:
                view = get_strategy(db, user_id, ref["id"])
                name, version_id, raw = view.row.name, view.version.id, view.spec
            except StrategyNotFound:
                found_stub = mvp_alerts.find_strategy(ref["id"]) if mvp_stub_enabled() else None
                if found_stub is None:
                    raise ArmProblem(index, "Strategy not found") from None
                name, version_id, raw = found_stub["spec"]["name"], ref["id"], found_stub["spec"]
        else:
            found = db.execute(
                select(FilterStrategy, FilterStrategyVersion)
                .join(FilterStrategyVersion, FilterStrategyVersion.id == FilterStrategy.current_version_id)
                .where(
                    FilterStrategy.id == ref["id"],
                    FilterStrategy.owner_user_id == user_id,
                    FilterStrategy.archived_at.is_(None),
                )
            ).first()
            if found is not None:
                name, version_id = found[0].name, found[1].id
                raw = _filter_as_spec(name, found[1].spec)
            else:  # the MVP stub's seed filters live in the fixture world, not in the database
                stub_row = (
                    next((r for r in mvp_world.filters() if r["id"] == ref["id"]), None) if mvp_stub_enabled() else None
                )
                if stub_row is None:
                    raise ArmProblem(index, "Filter not found")
                entry = next(e for e in load_catalog().entries if e.kind == "filter" and e.id == stub_row["key"])
                name, version_id = stub_row["name"], ref["id"]
                raw = _filter_as_spec(name, load_template(entry.file))
        try:
            problems = check(_replay_spec(raw, symbol))
        except ValueError as exc:
            raise ArmProblem(index, str(exc)) from None
        if problems:
            raise ArmProblem(index, "; ".join(problems))
        out.append(Armed(ref["source"], ref["id"], version_id, name, bias.get(name), raw))
    return out


def evaluate_window(
    armed: list[Armed],
    symbol: str,
    day: date,
    *,
    bars_1m: pd.DataFrame,
    daily: pd.DataFrame,
    window_start: pd.Timestamp,
    window_end: pd.Timestamp,
) -> list[Fire]:
    """Every would-fire signal of the armed strategies whose bar closes inside `(window_start, window_end]`, sorted
    by bar close. One engine run per strategy, at `as_of = window_end`."""
    fires: list[Fire] = []
    for item in armed:
        spec = _replay_spec(item.spec, symbol)
        run_on = spec.watch.runOn
        candidates = evaluate(
            spec,
            symbol,
            "stock",
            bars_1m=bars_1m if run_on in INTRADAY_CADENCES else None,
            bars_1d=daily,
            as_of=window_end,
        )
        kept = []
        for candidate in candidates:
            closes_at = bar_close(run_on, candidate.bar_time)
            if candidate.bar_time.tz_convert(ET).date() != day or not (window_start < closes_at <= window_end):
                continue
            kept.append(
                Fire(
                    source=item.source,  # type: ignore[arg-type]
                    id=item.id,
                    name=item.name,
                    bias=item.bias,
                    bar_time=candidate.bar_time,
                    bar_close=closes_at,
                    close=_close_of(bars_1m, daily, run_on, closes_at, candidate.bar_time),
                    evidence=dict(candidate.evidence),
                )
            )
        if item.spec["then"]["alert"].get("frequency") == "once":
            kept = sorted(kept, key=lambda f: f.bar_close)[:1]
        fires += kept
    return sorted(fires, key=lambda f: (f.bar_close, f.name))


def _close_of(bars_1m: pd.DataFrame, daily: pd.DataFrame, run_on: str, closes_at: pd.Timestamp, bar_time: pd.Timestamp):
    """The close of the evaluated bar: the last 1-minute bar closed by the bar's close (a daily bar's own close)."""
    if run_on in ("daily_close", "weekly"):
        day = bar_time.tz_convert(ET).date()
        row = daily[[d <= day for d in daily.index]]
        return float(row["close"].iloc[-1])
    last = bars_1m[bars_1m.index + MINUTE <= closes_at]
    return float(last["close"].iloc[-1])


def released(fires: list[Fire], through: pd.Timestamp) -> list[Fire]:
    return [f for f in fires if f.bar_close <= through]


def next_after(fires: list[Fire], through: pd.Timestamp) -> Fire | None:
    return next((f for f in fires if f.bar_close > through), None)


# -- storage (the session row's `signals` jsonb) -------------------------------------------------------------


def dump_fires(fires: list[Fire]) -> list[dict[str, Any]]:
    return [
        {
            "source": f.source,
            "id": f.id,
            "name": f.name,
            "bias": f.bias,
            "bar_time": f.bar_time.isoformat(),
            "bar_close": f.bar_close.isoformat(),
            "close": f.close,
            "evidence": f.evidence,
        }
        for f in fires
    ]


def load_fires(rows: list[dict[str, Any]]) -> list[Fire]:
    return [
        Fire(
            source=r["source"],
            id=r["id"],
            name=r["name"],
            bias=r["bias"],
            bar_time=pd.Timestamp(r["bar_time"]),
            bar_close=pd.Timestamp(r["bar_close"]),
            close=r["close"],
            evidence=r["evidence"],
        )
        for r in rows
    ]
