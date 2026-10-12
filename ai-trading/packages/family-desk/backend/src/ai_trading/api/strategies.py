"""`/api/desk/strategies*` (PROTO-BRIEF.md §4 L4).

Stage machine: `draft -> alert_only -> paper` only -- one step forward at a time, never a skip
(`draft -> paper`) and never backward; `paper` additionally requires an explicit
`{"confirm": true}` body field (02a §4.2). There is no `live_confirm`/`live_auto` stage in this
schema at all (Global Constraints, §2), so naming one is rejected the same way an out-of-order
move is: 400, not FastAPI's own 422, so every stage-machine violation reports through the same
error shape.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.evaluate import check
from ai_trading.db.models import Strategy, StrategyVersion

router = APIRouter(prefix="/api/desk/strategies", tags=["strategies"])

_STAGE_ORDER = ("draft", "alert_only", "paper")


class StrategyCreate(BaseModel):
    name: str


class StrategyOut(BaseModel):
    id: int
    name: str
    stage: str
    current_version_id: int | None


class StrategyVersionCreate(BaseModel):
    spec: dict[str, Any]
    change_note: str | None = None


class StrategyVersionOut(BaseModel):
    id: int
    strategy_id: int
    version: int
    schema_version: int
    spec: dict[str, Any]
    change_note: str | None


class StageUpdate(BaseModel):
    stage: str
    confirm: bool = False


def _owned_strategy(session: Session, strategy_id: int, user: AuthedUser) -> Strategy:
    row = session.get(Strategy, strategy_id)
    if row is None or row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="strategy not found")
    return row


def _strategy_out(row: Strategy) -> StrategyOut:
    return StrategyOut(id=row.id, name=row.name, stage=row.stage, current_version_id=row.current_version_id)


def _version_out(row: StrategyVersion) -> StrategyVersionOut:
    return StrategyVersionOut(
        id=row.id,
        strategy_id=row.strategy_id,
        version=row.version,
        schema_version=row.schema_version,
        spec=row.spec,
        change_note=row.change_note,
    )


@router.get("", response_model=list[StrategyOut])
def list_strategies(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[StrategyOut]:
    rows = session.execute(select(Strategy).where(Strategy.owner_user_id == user.id).order_by(Strategy.id)).scalars()
    return [_strategy_out(row) for row in rows]


@router.post("", status_code=201, response_model=StrategyOut)
def create_strategy(
    body: StrategyCreate, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> StrategyOut:
    row = Strategy(owner_user_id=user.id, name=body.name, stage="draft", created_at=datetime.now(UTC))
    session.add(row)
    session.flush()
    session.commit()
    return _strategy_out(row)


@router.get("/{strategy_id}/versions", response_model=list[StrategyVersionOut])
def list_versions(
    strategy_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[StrategyVersionOut]:
    strategy = _owned_strategy(session, strategy_id, user)
    rows = session.execute(
        select(StrategyVersion).where(StrategyVersion.strategy_id == strategy.id).order_by(StrategyVersion.version)
    ).scalars()
    return [_version_out(row) for row in rows]


@router.post("/{strategy_id}/versions", status_code=201, response_model=StrategyVersionOut)
def create_version(
    strategy_id: int,
    body: StrategyVersionCreate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> StrategyVersionOut:
    strategy = _owned_strategy(session, strategy_id, user)
    try:
        spec = StrategySpecV1.model_validate(body.spec)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid strategy spec: {exc}") from exc
    problems = check(spec)
    if problems:
        raise HTTPException(status_code=400, detail="; ".join(problems))

    latest_version = session.execute(
        select(StrategyVersion.version)
        .where(StrategyVersion.strategy_id == strategy.id)
        .order_by(StrategyVersion.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    row = StrategyVersion(
        strategy_id=strategy.id,
        version=(latest_version or 0) + 1,
        schema_version=spec.schemaVersion,
        spec=body.spec,
        change_note=body.change_note,
        created_by=user.id,
        created_at=datetime.now(UTC),
    )
    session.add(row)
    session.flush()
    # No separate "activate version" endpoint exists in this schema: the newest immutable version
    # becomes the one `engine.tick.tick` evaluates (decision; see REPORT-L4.md).
    strategy.current_version_id = row.id
    session.commit()
    return _version_out(row)


@router.put("/{strategy_id}/stage", response_model=StrategyOut)
def update_stage(
    strategy_id: int,
    body: StageUpdate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> StrategyOut:
    strategy = _owned_strategy(session, strategy_id, user)
    try:
        current_index = _STAGE_ORDER.index(strategy.stage)
        target_index = _STAGE_ORDER.index(body.stage)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown stage {body.stage!r}") from None
    if target_index != current_index + 1:
        raise HTTPException(
            status_code=400, detail=f"cannot move {strategy.stage!r} -> {body.stage!r}: only the next stage is allowed"
        )
    if body.stage == "paper" and not body.confirm:
        raise HTTPException(status_code=400, detail='moving to paper requires {"confirm": true}')
    strategy.stage = body.stage
    session.commit()
    return _strategy_out(strategy)
