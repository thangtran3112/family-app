"""`DESK_IBKR_GATEWAY_ENABLED` is the owner's switch for the IBKR slot, and it is OFF everywhere the repo
configures a deployed environment: it is turned on only by writing it into the Desk's Firestore profile after
the Monday probe (02e, 02m §b4 item 3). Nothing under `deploy/`, the image, `infrastructure/`, or the CI
workflows may set it, and the Desk never connects to IBKR from its own code -- it goes through the registry."""

from pathlib import Path

from ai_trading_common.registry import DataSources

FLAG = "DESK_IBKR_GATEWAY_ENABLED"
_BACKEND = Path(__file__).resolve().parents[1]
_AI_TRADING = _BACKEND.parents[2]
_REPO = _AI_TRADING.parent
_DEPLOY_PATHS = [
    _AI_TRADING / "deploy",
    _BACKEND / "Dockerfile",
    _BACKEND / "docker",
    _REPO / "infrastructure",
    *sorted((_REPO / ".github" / "workflows").glob("ai-trading*")),
]


def test_no_deploy_file_sets_the_gateway_flag():
    existing = [path for path in _DEPLOY_PATHS if path.exists()]
    assert existing, "deploy paths moved: update _DEPLOY_PATHS"
    offenders = []
    for root in existing:
        for path in [root] if root.is_file() else (p for p in root.rglob("*") if p.is_file()):
            try:
                if FLAG in path.read_text(errors="ignore"):
                    offenders.append(str(path.relative_to(_REPO)))
            except OSError:
                continue
    assert offenders == []


def test_with_no_flag_the_desks_data_sources_have_no_gateway():
    sources = DataSources.from_env(env={})
    assert sources.gateway_status().state == "not_configured"
    assert [type(p).__name__ for p in sources.quotes.providers] == ["AlpacaBars"]


def test_the_desk_source_never_names_the_ibkr_wire_client_or_an_order_call():
    banned = ("ib_async", "ibapi", "placeOrder", "cancelOrder", "MarketOrder", "LimitOrder")
    offenders = {
        str(path.relative_to(_BACKEND)): [word for word in banned if word in path.read_text()]
        for path in sorted((_BACKEND / "src").rglob("*.py"))
        if any(word in path.read_text() for word in banned)
    }
    assert offenders == {}
