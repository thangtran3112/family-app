"""RFC 6901 pointers and a three-op subset of RFC 6902 (replace / add / remove).

Mirror of contracts/src/json-pointer.ts. A strategy draft stores the user's edits as these ops
so `draftConfig + edits = finalConfig` can be replayed and checked in both languages.
"""

import copy
import math
import re
from typing import Annotated, Any, Literal

from pydantic import Field, field_validator

from ai_trading.contracts.common import ConfigModel

JsonPointer = Annotated[str, Field(max_length=200, pattern=r"^(\/([^/~]|~[01])*)+$")]
_ARRAY_INDEX = re.compile(r"^(0|[1-9][0-9]*)$")


class EditError(ValueError):
    pass


def check_json_value(value: Any) -> Any:
    """Reject null, booleans, and non-string keys anywhere in `value` (Zod's JsonValueSchema)."""
    if isinstance(value, bool) or value is None:
        raise ValueError("null and boolean values are not allowed")
    if isinstance(value, list):
        for item in value:
            check_json_value(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("object keys must be strings")
            check_json_value(item)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("numbers must be finite")
    elif not isinstance(value, (int, str)):
        raise ValueError("not a JSON value")
    return value


class Edit(ConfigModel):
    op: Literal["replace", "add", "remove"]
    path: JsonPointer
    value: Any = None

    @field_validator("value")
    @classmethod
    def _json_value(cls, value: Any) -> Any:
        return value if value is None else check_json_value(value)

    def model_post_init(self, __context: Any) -> None:
        # Zod: replace/add require `value`; remove forbids it. Strict models never accept an
        # explicit null (SpecModel), so "unset" is exactly "not in model_fields_set".
        has_value = "value" in self.model_fields_set
        if self.op == "remove" and has_value:
            raise ValueError("remove takes no value")
        if self.op != "remove" and not has_value:
            raise ValueError(f"{self.op} requires a value")


def _tokens(pointer: str) -> list[str]:
    return [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]


def _escape(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def resolve_pointer(doc: Any, pointer: str) -> tuple[bool, Any]:
    """(found, value) for `pointer` in `doc`."""
    current = doc
    for token in _tokens(pointer):
        if isinstance(current, list):
            if not _ARRAY_INDEX.match(token) or int(token) >= len(current):
                return False, None
            current = current[int(token)]
        elif isinstance(current, dict) and token in current:
            current = current[token]
        else:
            return False, None
    return True, current


def apply_edits(doc: Any, edits: list[Edit]) -> Any:
    """A copy of `doc` with `edits` applied in order; raises EditError when an op cannot apply."""
    result = copy.deepcopy(doc)
    for edit in edits:
        parts = _tokens(edit.path)
        if "__proto__" in parts:
            raise EditError(f"{edit.path}: forbidden token")
        last = parts[-1]
        if len(parts) == 1:
            container = result
        else:
            found, container = resolve_pointer(result, "/" + "/".join(_escape(p) for p in parts[:-1]))
            if not found:
                raise EditError(f"{edit.path}: parent not found")
        if isinstance(container, list):
            if last == "-" and edit.op == "add":
                index = len(container)
            elif _ARRAY_INDEX.match(last):
                index = int(last)
            else:
                raise EditError(f"{edit.path}: bad array index")
            if edit.op == "add":
                if index > len(container):
                    raise EditError(f"{edit.path}: index out of range")
                container.insert(index, copy.deepcopy(edit.value))
            else:
                if index >= len(container):
                    raise EditError(f"{edit.path}: index out of range")
                if edit.op == "replace":
                    container[index] = copy.deepcopy(edit.value)
                else:
                    del container[index]
        elif isinstance(container, dict):
            if edit.op != "add" and last not in container:
                raise EditError(f"{edit.path}: target not found")
            if edit.op == "remove":
                del container[last]
            else:
                container[last] = copy.deepcopy(edit.value)
        else:
            raise EditError(f"{edit.path}: parent is not a container")
    return result


def json_equal(a: Any, b: Any) -> bool:
    """Deep equality for JSON values (key order ignored; 2 == 2.0, as in JavaScript)."""
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    return a == b
