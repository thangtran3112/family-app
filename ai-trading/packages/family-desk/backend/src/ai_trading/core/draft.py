"""The `draft_filter` tool (02k section 8; 02a section 5 "chat drafting"): turns an AI assistant's
proposal for a screener into a schema-valid `FilterStrategySpecV1`, the problems that keep the
engine from running it, and a diff against the current version.

Nothing here saves anything or places an order. The exchange is `StrategyDraft`: `to_strategy_draft`
wraps a response as a `proposed` draft, and `finalize_filter_draft` turns the user's edits into the
`final` draft whose `finalConfig` is the validated result (draft + edits = final, replayed and
checked by `StrategyDraft` itself). `DraftResponse` is a Pydantic-only API model, not a contract.
"""

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from ai_trading.contracts.json_pointer import Edit, apply_edits, json_equal
from ai_trading.contracts.strategy_draft import DraftTarget, StrategyDraft
from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.core.evaluate import check_filter


class DraftResponse(BaseModel):
    """`spec` is the canonical config (None when the proposal is not schema-valid); `problems` lists
    schema errors or, for a schema-valid spec, what the engine cannot run; `diff` turns the base
    version into `spec` (empty without a base); `basedOnVersionId` echoes the caller's base."""

    model_config = ConfigDict(extra="forbid")

    kind: DraftTarget
    spec: dict[str, Any] | None
    problems: list[str]
    diff: list[Edit]
    basedOnVersionId: int | None = None


def draft_filter(
    proposal: Mapping[str, Any],
    *,
    base: Mapping[str, Any] | None = None,
    based_on_version_id: int | None = None,
) -> DraftResponse:
    """Validates `proposal` as a `FilterStrategySpecV1` and diffs it against `base` (the current
    stored version, already valid). The output never raises on a bad proposal: schema errors land in
    `problems` with `spec` None, and an engine problem (`check_filter`) leaves `spec` set. The diff
    is replayed on `base` and must reproduce `spec`, and the canonical spec must survive a re-parse."""
    try:
        parsed = FilterStrategySpecV1.model_validate(proposal)
    except ValidationError as exc:
        problems = [
            _describe(error) for error in exc.errors(include_url=False, include_input=False, include_context=False)
        ]
        return DraftResponse(kind="filter", spec=None, problems=problems, diff=[], basedOnVersionId=based_on_version_id)

    spec = _dump(parsed)
    problems = check_filter(parsed)
    if not json_equal(_dump(FilterStrategySpecV1.model_validate(spec)), spec):
        problems.append("the proposed spec does not survive a dump and re-parse")
    diff: list[Edit] = []
    if base is not None:
        current = _dump(FilterStrategySpecV1.model_validate(base))
        diff = diff_edits(current, spec)
        if not json_equal(apply_edits(current, diff), spec):
            problems.append("the diff does not replay to the proposed spec")
    return DraftResponse(kind="filter", spec=spec, problems=problems, diff=diff, basedOnVersionId=based_on_version_id)


def to_strategy_draft(
    response: DraftResponse, *, draft_id: str, created_at: str, request: str, rationale: str
) -> StrategyDraft:
    """The `proposed` draft for a schema-valid response (raises `ValueError` otherwise). `StrategyDraft`
    re-checks every draft rule, so a response that passes here is a valid exchange document."""
    if response.kind != "filter" or response.spec is None:
        raise ValueError("only a schema-valid filter response can become a draft")
    return StrategyDraft.model_validate(
        {
            "schemaVersion": 1,
            "draftId": draft_id,
            "createdAt": created_at,
            "request": request,
            "rationale": rationale,
            "status": "proposed",
            "target": "filter",
            "draftConfig": response.spec,
            "edits": [],
        }
    )


def finalize_filter_draft(draft: StrategyDraft, edits: Sequence[Edit]) -> StrategyDraft:
    """The `final` draft after the user accepts `draft` with `edits` applied. Raises `ValueError` when
    the draft is not a filter draft, the edits do not apply, or the result is invalid or not runnable:
    only a validated, engine-checked config ever becomes `finalConfig`."""
    if draft.target != "filter" or not isinstance(draft.draftConfig, FilterStrategySpecV1):
        raise ValueError("only a filter draft can be finalized here")
    if draft.status not in ("proposed", "edited"):
        raise ValueError(f"a {draft.status} draft cannot be finalized")
    edited = apply_edits(_dump(draft.draftConfig), list(edits))  # EditError is a ValueError
    final = FilterStrategySpecV1.model_validate(edited)  # ValidationError is a ValueError
    problems = check_filter(final)
    if problems:
        raise ValueError("; ".join(problems))
    return StrategyDraft.model_validate(
        {
            **draft.model_dump(mode="json", by_alias=True, exclude_none=True),
            "status": "final",
            "edits": [edit.model_dump(mode="json", exclude_unset=True) for edit in edits],
            "finalConfig": _dump(final),
        }
    )


_DEEP_PATH = 120  # below Edit's 200-character pointer cap, with room for the next key


def diff_edits(old: Any, new: Any, path: str = "") -> list[Edit]:
    """RFC 6902-style ops (replace / add / remove) that turn `old` into `new`. Objects diff key by
    key; arrays diff element by element when they keep their length and are replaced whole when not;
    a subtree whose pointer is longer than `_DEEP_PATH` is replaced whole."""
    if json_equal(old, new):
        return []
    if len(path) > _DEEP_PATH:
        return [Edit(op="replace", path=path, value=new)]  # keeps every pointer under Edit's length cap
    if isinstance(old, dict) and isinstance(new, dict):
        edits = [Edit(op="remove", path=f"{path}/{_escape(key)}") for key in old if key not in new]
        for key, value in new.items():
            child = f"{path}/{_escape(key)}"
            edits += diff_edits(old[key], value, child) if key in old else [Edit(op="add", path=child, value=value)]
        return edits
    if isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        return [edit for i, (a, b) in enumerate(zip(old, new, strict=True)) for edit in diff_edits(a, b, f"{path}/{i}")]
    return [Edit(op="replace", path=path, value=new)]


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def _escape(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _describe(error: Mapping[str, Any]) -> str:
    where = ".".join(str(part) for part in error["loc"])
    return f"{where}: {error['msg']}" if where else str(error["msg"])
