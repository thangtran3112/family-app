"""Turn a Pydantic `ValidationError` into the `problems` list of 02m §a1: a plain message plus a dotted
JSON path (`then.alert.channels`) the form shows muted under the message."""

from collections import defaultdict
from typing import Any

from pydantic import ValidationError

from ai_trading.contracts.alert_strategy import ALERT_RULES

MAX_PROBLEMS = 10
_PREFIXES = ("Value error, ", "Assertion failed, ")
_CHANNEL_RULES = {rule.description for rule in ALERT_RULES}


def _branch_index(loc: tuple[Any, ...]) -> int | None:
    """Index of the first union-branch segment: pydantic puts the branch's class name in the location
    ("CompareCondition", "LevelOperand2"). Class names start upper-case; field names never do."""
    return next((i for i, part in enumerate(loc) if isinstance(part, str) and part[:1].isupper()), None)


def _collapse_unions(locs: list[tuple[Any, ...]], messages: list[str]) -> list[tuple[tuple[Any, ...], str]]:
    """A union field reports every branch's errors. Keep only the branch the input fits best: the one
    with the fewest errors at the branch's own top level (wrong keys), then the fewest overall."""
    errors = list(zip(locs, messages, strict=True))
    while any(_branch_index(loc) is not None for loc, _ in errors):
        first = next(loc for loc, _ in errors if _branch_index(loc) is not None)
        cut = _branch_index(first)
        prefix = first[:cut]
        groups: dict[Any, list[int]] = defaultdict(list)
        for position, (loc, _) in enumerate(errors):
            if loc[:cut] == prefix and len(loc) > cut and _branch_index(loc) == cut:
                groups[loc[cut]].append(position)
        best = min(
            groups,
            key=lambda branch: (sum(1 for p in groups[branch] if len(errors[p][0]) == cut + 2), len(groups[branch])),
        )
        drop = {p for branch, positions in groups.items() if branch != best for p in positions}
        errors = [
            ((*loc[:cut], *loc[cut + 1 :]) if position in groups[best] else loc, message)
            for position, (loc, message) in enumerate(errors)
            if position not in drop
        ]
    return errors


def _message(text: str) -> str:
    for prefix in _PREFIXES:
        if text.startswith(prefix):
            return text[len(prefix) :]
    return text


def problems_from_validation_error(exc: ValidationError) -> list[dict[str, str]]:
    raw = exc.errors(include_url=False, include_context=False, include_input=False)
    seen: set[tuple[str, str]] = set()
    problems: list[dict[str, str]] = []
    for loc, text in _collapse_unions([tuple(e["loc"]) for e in raw], [_message(e["msg"]) for e in raw]):
        for message in text.split("; "):
            # The alert contract's model validator raises at the root; the rule is about the channels.
            path = "then.alert.channels" if not loc and message in _CHANNEL_RULES else ".".join(map(str, loc))
            if (path, message) not in seen:
                seen.add((path, message))
                problems.append({"path": path, "message": message})
    return problems[:MAX_PROBLEMS]
