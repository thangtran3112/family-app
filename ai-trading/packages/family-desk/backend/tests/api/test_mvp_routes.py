"""Route-level guarantees of the technical desktop MVP (02m §a2, §d3): the endpoint inventory is exactly
the spec's, every route is behind the gateway identity, no route can place or preview an order, and every
operation declares a typed response (the OpenAPI file is the frozen contract for the frontend)."""

import re

import pytest
from fastapi.testclient import TestClient

from ai_trading.api.app import app

# (method, path) of 02m §a2 rows 1-53, 02o §b1 rows 54-63 and 02o-b v1 rows 64-69.
# Path parameters are normalised to `{}`.
INVENTORY: list[tuple[str, str]] = [
    ("GET", "/api/desk/me"),
    ("GET", "/api/desk/status"),
    ("GET", "/api/desk/symbols/search"),
    ("GET", "/api/desk/dashboard"),
    ("GET", "/api/desk/bars/{}"),
    ("GET", "/api/desk/technicals/{}"),
    ("GET", "/api/desk/quotes/{}"),
    ("GET", "/api/desk/charts/{}/markers"),
    ("GET", "/api/desk/signals"),
    ("GET", "/api/desk/screener/filters"),
    ("POST", "/api/desk/screener/filters"),
    ("GET", "/api/desk/screener/filters/{}"),
    ("PUT", "/api/desk/screener/filters/{}"),
    ("DELETE", "/api/desk/screener/filters/{}"),
    ("GET", "/api/desk/screener/filters/{}/results"),
    ("POST", "/api/desk/screener/preview"),
    ("GET", "/api/desk/screener/universe"),
    ("GET", "/api/desk/watchlists"),
    ("POST", "/api/desk/watchlists"),
    ("PATCH", "/api/desk/watchlists/{}"),
    ("DELETE", "/api/desk/watchlists/{}"),
    ("GET", "/api/desk/watchlists/{}/items"),
    ("POST", "/api/desk/watchlists/{}/items"),
    ("DELETE", "/api/desk/watchlists/{}/items/{}"),
    ("PUT", "/api/desk/watchlists/{}/order"),
    ("GET", "/api/desk/watchlists/{}/table"),
    ("GET", "/api/desk/library"),
    ("GET", "/api/desk/library/{}"),
    ("POST", "/api/desk/library/{}/attach"),
    ("GET", "/api/desk/alert-strategies"),
    ("POST", "/api/desk/alert-strategies"),
    ("POST", "/api/desk/alert-strategies/validate"),
    ("GET", "/api/desk/alert-strategies/{}"),
    ("PUT", "/api/desk/alert-strategies/{}"),
    ("DELETE", "/api/desk/alert-strategies/{}"),
    ("POST", "/api/desk/alert-strategies/{}/pause"),
    ("POST", "/api/desk/alert-strategies/{}/resume"),
    ("GET", "/api/desk/alert-strategies/{}/fires"),
    ("GET", "/api/desk/alerts"),
    ("POST", "/api/desk/alerts/{}/read"),
    ("POST", "/api/desk/alerts/read-all"),
    ("GET", "/api/desk/alerts/log"),
    ("GET", "/api/desk/settings"),
    ("PUT", "/api/desk/settings"),
    ("GET", "/api/desk/settings/channels"),
    ("PUT", "/api/desk/settings/channels/telegram"),
    ("POST", "/api/desk/settings/channels/{}/test"),
    # Rows 48-53: the legacy generic strategy API and futures specs, unchanged.
    ("GET", "/api/desk/strategies"),
    ("POST", "/api/desk/strategies"),
    ("GET", "/api/desk/strategies/{}/versions"),
    ("POST", "/api/desk/strategies/{}/versions"),
    ("PUT", "/api/desk/strategies/{}/stage"),
    ("GET", "/api/desk/futures/specs"),
    # Rows 54-63: the Practice (replay) lane, 02o §b1.
    ("GET", "/api/desk/replay/days"),
    ("GET", "/api/desk/replay/sessions"),
    ("POST", "/api/desk/replay/sessions"),
    ("GET", "/api/desk/replay/sessions/{}"),
    ("PATCH", "/api/desk/replay/sessions/{}"),
    ("POST", "/api/desk/replay/sessions/{}/advance"),
    ("GET", "/api/desk/replay/sessions/{}/feed"),
    ("POST", "/api/desk/replay/sessions/{}/marks"),
    ("DELETE", "/api/desk/replay/sessions/{}/marks/{}"),
    ("POST", "/api/desk/replay/sessions/{}/end"),
    # Rows 64-69: daily-list practice, 02o-b v1.
    ("GET", "/api/desk/replay/daily"),
    ("POST", "/api/desk/replay/daily/next"),
    ("GET", "/api/desk/replay/day-lists/{}"),
    ("PATCH", "/api/desk/replay/day-lists/{}"),
    ("POST", "/api/desk/replay/day-lists/{}/sessions"),
    ("POST", "/api/desk/replay/day-lists/{}/end"),
]

#: `PUT /watchlists/{id}/order` reorders symbols (02m §a2 row 25). It is the one route whose path may
#: contain the word "order": the guard below is about placing orders.
REORDER_ROUTE = "/api/desk/watchlists/{}/order"
_FORBIDDEN = re.compile(r"order|position|broker", re.IGNORECASE)


def _desk_routes() -> list[tuple[str, str]]:
    """Every `/api/desk` (method, path) the app serves, read from the OpenAPI document: this FastAPI nests
    included routers (`app.routes` holds one opaque entry per router), the document is the flat list."""
    found = []
    for path, operations in app.openapi()["paths"].items():
        if path.startswith("/api/desk"):
            found += [(method.upper(), re.sub(r"\{[^}]*\}", "{}", path)) for method in operations]
    return found


def test_inventory_is_exactly_the_spec() -> None:
    found = _desk_routes()
    assert len(found) == len(set(found)), "a method and path is declared twice"
    assert sorted(found) == sorted(INVENTORY)
    assert len(INVENTORY) == 69


def test_no_route_can_place_preview_or_name_an_order_a_position_or_a_broker() -> None:
    offenders = [
        f"{method} {path}" for method, path in _desk_routes() if _FORBIDDEN.search(path) and path != REORDER_ROUTE
    ]
    assert offenders == []


@pytest.mark.parametrize(("method", "path"), INVENTORY, ids=[f"{m} {p}" for m, p in INVENTORY])
def test_every_desk_route_answers_401_without_the_gateway_identity(client: TestClient, method: str, path: str) -> None:
    url = path.replace("{}", "1")
    assert client.request(method, url).status_code == 401


def test_every_operation_declares_a_typed_response() -> None:
    schema = app.openapi()
    untyped = []
    for path, operations in schema["paths"].items():
        if not path.startswith("/api/desk") or path.startswith("/api/desk/quotes/"):
            continue  # the SSE stream has no JSON body schema
        for method, operation in operations.items():
            success = next((code for code in operation["responses"] if code.startswith("2")), None)
            if success is None:
                untyped.append(f"{method} {path}: no 2xx response")
            elif success != "204" and "content" not in operation["responses"][success]:
                untyped.append(f"{method} {path}: {success} has no content schema")
    assert untyped == []
