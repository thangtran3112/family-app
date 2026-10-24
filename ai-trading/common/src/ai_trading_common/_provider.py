"""`Provider`'s actual definition (internal).

Lives in its own leaf module, with no dependency on `registry.py` or `providers/*`, so that
`providers/<name>.py` modules can import it without a `registry.py` <-> `providers` import
cycle regardless of which module a caller (or a test) imports first. `registry.py` re-exports
it as `ai_trading_common.registry.Provider`, which is the name §5 fixes -- this file is not
part of the public layout.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ai_trading_common.http import ThrottledClient


def _always(env: Mapping[str, str]) -> bool:
    return True


@dataclass(frozen=True)
class Provider:
    """One vendor's registry entry. `build(env, http)` returns the vendor's adapter -- an object
    implementing every kind in `kinds`. Called at most once per `from_env` run; the same instance
    is shared across every kind chain it appears in (§5: "one adapter per vendor").

    `enabled(env)` is a switch for a provider that must be explicitly turned on (the IBKR gateway,
    off by default): while it is False the registry leaves the provider out of every chain, so the
    next provider is the primary and its results are not labeled `fallback`."""

    name: str
    kinds: tuple[str, ...]
    build: Callable[[Mapping[str, str], ThrottledClient], object]
    enabled: Callable[[Mapping[str, str]], bool] = _always
