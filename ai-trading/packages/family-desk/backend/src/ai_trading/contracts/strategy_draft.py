"""Strategy draft (kind "draft"): an AI assistant's proposal for a filter or an alert, the user's edits
to it, and the final config the user accepted.

Mirror of contracts/src/strategy-draft.ts: same field names, same limits, same rules. Every rule in
DRAFT_RULES has a same-named check in `_draft_rules` with the same message (the Zod superRefine is
the source of truth for the ids). Hand-written, not generated. Nothing here places an order.
"""

from typing import Annotated, Any, Literal, NamedTuple

from pydantic import BaseModel, Field, ValidationError, model_validator

from ai_trading.contracts.alert_strategy import AlertStrategy
from ai_trading.contracts.common import ConfigModel, SchemaVersion, Slug, UtcTimestamp
from ai_trading.contracts.filter_strategy import FilterStrategy
from ai_trading.contracts.json_pointer import Edit, EditError, apply_edits, json_equal


class _Rule(NamedTuple):
    id: str
    description: str


DRAFT_RULES: tuple[_Rule, ...] = (
    _Rule("proposed-no-edits", "a proposed draft has no edits"),
    _Rule("proposed-no-final-config", "a proposed draft has no finalConfig"),
    _Rule("edited-has-edits", "an edited draft has at least one edit"),
    _Rule("edited-no-final-config", "an edited draft has no finalConfig"),
    _Rule("final-has-final-config", "a final draft has a finalConfig"),
    _Rule("rejected-no-final-config", "a rejected draft has no finalConfig"),
    _Rule("final-config-kind", "finalConfig.kind must equal draftConfig.kind"),
    _Rule("edits-apply", "edits must apply cleanly to draftConfig"),
    _Rule("edited-config-valid", "draftConfig with the edits applied must be a valid config of its kind"),
    _Rule("final-round-trip", "draftConfig with the edits applied must equal finalConfig"),
)
_RULE_TEXT: dict[str, str] = {rule.id: rule.description for rule in DRAFT_RULES}

DraftConfig = Annotated[FilterStrategy | AlertStrategy, Field(discriminator="kind")]
DraftStatus = Literal["proposed", "edited", "final", "rejected"]
DraftText = Annotated[str, Field(min_length=1, max_length=2000)]


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


class StrategyDraft(ConfigModel):
    schemaVersion: SchemaVersion
    kind: Literal["draft"]
    draftId: Slug
    createdAt: UtcTimestamp
    request: DraftText
    rationale: DraftText
    status: DraftStatus
    draftConfig: DraftConfig
    edits: Annotated[list[Edit], Field(max_length=50)]
    finalConfig: DraftConfig | None = None

    @model_validator(mode="after")
    def _draft_rules(self) -> "StrategyDraft":
        problems: list[str] = []

        def fail(rule_id: str) -> None:
            problems.append(_RULE_TEXT[rule_id])

        final = self.finalConfig
        if self.status == "proposed" and self.edits:
            fail("proposed-no-edits")
        if self.status == "proposed" and final is not None:
            fail("proposed-no-final-config")
        if self.status == "edited" and not self.edits:
            fail("edited-has-edits")
        if self.status == "edited" and final is not None:
            fail("edited-no-final-config")
        if self.status == "final" and final is None:
            fail("final-has-final-config")
        if self.status == "rejected" and final is not None:
            fail("rejected-no-final-config")
        kinds_match = final is None or final.kind == self.draftConfig.kind
        if not kinds_match:
            fail("final-config-kind")

        if self.status in ("edited", "final"):
            try:
                edited = apply_edits(_dump(self.draftConfig), self.edits)
            except EditError:
                fail("edits-apply")
            else:
                config_type = FilterStrategy if self.draftConfig.kind == "filter" else AlertStrategy
                try:
                    replayed = _dump(config_type.model_validate(edited))
                except ValidationError:
                    fail("edited-config-valid")
                else:
                    if (
                        self.status == "final"
                        and final is not None
                        and kinds_match
                        and not json_equal(replayed, _dump(final))
                    ):
                        fail("final-round-trip")

        if problems:
            raise ValueError("; ".join(problems))
        return self
