"""Every registered provider's adapter is an instance of each declared kind's Protocol (02j §9:
"Conformance"). Built with empty keys and a fake-backed `ThrottledClient` so this test never
touches the network -- it only checks shape, never behavior (each provider's own
`tests/providers/test_<name>.py` covers behavior).

A runtime-checkable Protocol's `isinstance` only checks that each method exists, so each method's
signature is also bound against the Protocol's own call shape: an adapter missing a parameter
(say, `now`) fails here instead of at the first real call."""

import inspect

import pytest

from ai_trading_common.registry import KIND_PROTOCOLS, REGISTRY
from ai_trading_common.sources import TradesSource
from ai_trading_common.testing import make_client


def _protocol_call(method) -> tuple[list[object], dict[str, object]]:
    """Dummy arguments in the Protocol method's own shape: positional parameters by position,
    keyword-only ones by name, optional ones included."""
    params = list(inspect.signature(method).parameters.values())[1:]  # drop `self`
    args = [object() for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    kwargs = {p.name: object() for p in params if p.kind is p.KEYWORD_ONLY}
    return args, kwargs


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_every_kind_a_provider_declares_is_actually_satisfied(name):
    provider = REGISTRY[name]
    http, _, _ = make_client([])
    adapter = provider.build({}, http)
    for kind in provider.kinds:
        protocol = KIND_PROTOCOLS[kind]
        assert isinstance(adapter, protocol), f"{name}'s adapter does not satisfy {protocol.__name__} for {kind!r}"
        for method_name, method in vars(protocol).items():
            if method_name.startswith("_") or not callable(method):
                continue
            args, kwargs = _protocol_call(method)
            try:
                inspect.signature(getattr(adapter, method_name)).bind(*args, **kwargs)
            except TypeError as exc:
                pytest.fail(f"{name}.{method_name} does not accept {protocol.__name__}'s call: {exc}")


def test_every_kind_in_default_chains_is_served_by_every_provider_it_names():
    from ai_trading_common.registry import DEFAULT_CHAINS

    for kind, names in DEFAULT_CHAINS.items():
        for name in names:
            assert kind in REGISTRY[name].kinds, f"{name!r} is in DEFAULT_CHAINS[{kind!r}] but does not serve it"


def test_alpaca_serves_trades_as_a_trades_source():
    http, _, _ = make_client([])
    assert "trades" in REGISTRY["alpaca"].kinds
    assert isinstance(REGISTRY["alpaca"].build({}, http), TradesSource)
