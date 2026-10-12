"""Provider fallback: try data sources in order, reacting by behavior, not by vendor.

Pattern adapted from TradingAgents `dataflows/router.py`'s `route_to_vendor`
(Apache-2.0; idea only, no code copied — 02a §11 "pattern"): `NotConfigured`,
`Unavailable`, and `SoftBanned` say nothing about the instrument and fall
through to the next call. `NoData` is a real answer but must not be the final
word when some other call in the chain was actually unreachable — an outage
must never look like "no data" (the brief's rule), so a transient failure
anywhere in the chain is reported ahead of a `NoData` collected from another
call, the same precedence `route_to_vendor` gives `VendorUnavailableError`
over `NoMarketDataError`.

This is the one fallback helper for the package: generic over the return
type, so a bars chain, a consensus-EPS chain, or anything else composes the
same precedence without each caller re-deriving it. A caller that needs a
quality label (e.g. `Bars.quality`) relabels the result itself using the
returned `is_primary` flag — the label is a per-type concern this helper
does not know about.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable


def first_success[T](calls: Sequence[Callable[[], T]]) -> tuple[T, bool]:
    """Try each call in order; returns `(result, is_primary)`.

    `calls` are zero-argument callables, each a closure over one real call.
    `is_primary` is `True` only when `calls[0]` itself succeeded; every later
    success reports `False`, so a caller that labels non-primary results
    (e.g. `quality="fallback"`) knows which one it got.

    Raises the chain's most informative failure once every call has failed:
    - a `NotConfigured`/`Unavailable`/`SoftBanned` from any call, if one
      occurred (an outage must not be reported as "no data");
    - otherwise the first `NoData` seen, when every call genuinely answered
      "nothing here".
    """
    if not calls:
        raise ValueError("first_success needs at least one call")

    first_no_data: NoData | None = None
    last_transient: ProviderError | None = None
    for index, call in enumerate(calls):
        try:
            return call(), index == 0
        except NoData as exc:
            first_no_data = first_no_data or exc
        except (NotConfigured, Unavailable, SoftBanned) as exc:
            last_transient = exc

    if last_transient is not None:
        raise last_transient
    assert first_no_data is not None  # calls is non-empty: one branch always set a result
    raise first_no_data
