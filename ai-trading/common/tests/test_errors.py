import pytest

from ai_trading_common.errors import NoData, NotConfigured, ProviderError, SoftBanned, Unavailable


def test_provider_error_carries_the_provider():
    error = ProviderError("alpaca", "boom")
    assert error.provider == "alpaca"
    assert "alpaca" in str(error)
    assert "boom" in str(error)


@pytest.mark.parametrize("cls", [NotConfigured, Unavailable, SoftBanned, NoData])
def test_every_variant_is_a_provider_error(cls):
    assert issubclass(cls, ProviderError)


def test_soft_banned_is_an_unavailable():
    assert issubclass(SoftBanned, Unavailable)
