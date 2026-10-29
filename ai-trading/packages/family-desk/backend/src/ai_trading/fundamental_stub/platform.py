"""Stub builders for the extended and cross-lane endpoints of 02n §c2: `GET /dashboard/fundamental` (#1), `GET
/futures/readings` (#11), the fundamental alert templates (#16, #17), the three `/status` fields (#18) and the
`fundamentals` object of a `long_term` watchlist row (#20)."""

from typing import Any

from ai_trading.fundamental_stub import holdings, stamp, unavailable_stamp
from ai_trading.fundamental_stub import world as w

ALERT_RULES: dict[str, dict[str, float | bool]] = {
    "covered_call_income": {"min_annualized_yield_pct": 15.0, "min_iv_rank": 50.0, "skip_earnings": True},
    "short_call_risk": {"delta_above": 0.5, "near_strike_pct": 2.0, "days_to_expiry": 7.0},
    "ai_daily_view": {
        "rating_change": True,
        "cross_target": True,
        "eps_revision_pct": 3.0,
        "earnings_within_days": 3.0,
        "confidence_below": 50.0,
    },
}
#: Template -> the strategy version its toggle last saved; `None` is a template never turned on.
_STRATEGY_ID = {"covered_call_income": 11, "short_call_risk": 12, "ai_daily_view": None}
_MACRO_WEEK = (
    {"date": "2026-10-29", "release": "GDP, advance estimate", "series_id": "GDP"},
    {"date": "2026-10-30", "release": "PCE price index", "series_id": "PCEPI"},
)


def _newest_first(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: item["at"], reverse=True)


def status() -> dict[str, Any]:
    """The three fields `GET /status` gained: the import, the option quotes, the Desk AI run."""
    return {
        "holdings": holdings.import_state(),
        "options": {**stamp(), "state": "connected"},
        "ai_daily": {"state": "ok", "last_run_at": "2026-10-23T21:05:00Z"},
    }


def dashboard() -> dict[str, Any]:
    strip = [{"symbol": s, "last": last, "change_pct": change, "stamp": stamp()} for s, last, change in w.STRIP]
    strip += [{"symbol": f"/{r}", "last": None, "change_pct": None, "stamp": unavailable_stamp()} for r in ("ES", "NQ")]
    totals = holdings.totals()
    return {
        "stamp": stamp(),
        "market": {"session": "closed", "next_open": "2026-10-26T13:30:00Z", "next_update_at": None},
        "market_strip": strip,
        "portfolio": {
            "value": totals["market_value"],
            "day_change": totals["day_change"],
            "day_change_pct": totals["day_change_pct"],
            "unrealized_pct": totals["unrealized_pct"],
            "import": holdings.import_state(),
        },
        "feed": _newest_first(
            [
                {
                    "kind": "short_call_risk",
                    "symbol": "KO",
                    "title": "KO short call is at its strike",
                    "detail": "Strike 72.50 expires Oct 30; the price is 71.90 and earnings fall before expiry.",
                    "at": "2026-10-23T20:05:00Z",
                    "href": "/covered-calls#income",
                },
                {
                    "kind": "earnings_soon",
                    "symbol": "KO",
                    "title": "KO reports Oct 27",
                    "detail": "Before its call expires on Oct 30.",
                    "at": "2026-10-23T20:00:00Z",
                    "href": "/stocks?symbol=KO#overview",
                },
                {
                    "kind": "earnings_soon",
                    "symbol": "MSFT",
                    "title": "MSFT reports Oct 28",
                    "detail": "After the close.",
                    "at": "2026-10-23T20:00:00Z",
                    "href": "/stocks?symbol=MSFT#overview",
                },
                {
                    "kind": "cc_opportunity",
                    "symbol": "AAPL",
                    "title": "AAPL covered call: 16.1% a year",
                    "detail": "IRA: the Nov 20 245 call, delta 0.28, bid 2.85.",
                    "at": "2026-10-23T19:30:00Z",
                    "href": "/covered-calls#scan",
                },
                {
                    "kind": "ai_change",
                    "symbol": "MSFT",
                    "title": "Desk AI moved MSFT from Buy to Hold",
                    "detail": "Base target 445.",
                    "at": "2026-10-23T21:05:00Z",
                    "href": "/stocks?symbol=MSFT#overview",
                },
                {
                    "kind": "import",
                    "symbol": None,
                    "title": f"Holdings imported: {w.LOT_COUNT} lots",
                    "detail": "IBKR Flex statement for Fri 2026-10-23.",
                    "at": "2026-10-24T09:15:00Z",
                    "href": "/holdings",
                },
            ]
        ),
        "income": {"month_to_date": 345.0, "open_calls": sum(c[5] for c in w.SHORT_CALLS), "next_expiry": "2026-10-30"},
        "events": [
            {"symbol": "KO", "kind": "earnings", "date": "2026-10-27", "label": "KO earnings"},
            {"symbol": "MSFT", "kind": "earnings", "date": "2026-10-28", "label": "MSFT earnings"},
            {"symbol": None, "kind": "macro", "date": "2026-10-29", "label": "GDP, advance estimate"},
            {"symbol": "KO", "kind": "ex_dividend", "date": "2026-11-13", "label": "KO ex-dividend"},
        ],
    }


def futures_readings() -> dict[str, Any]:
    """ES and NQ carry simulated prices; CL and GC have no provider, so their prices are null with the unavailable
    stamp. The roll and expiry dates are `core/futures.py`'s own."""
    prices = {"ES": (6120.25, 0.3, 6155.0, 6040.5), "NQ": (21480.5, 0.5, 21610.0, 21090.0)}
    rows = []
    for root in ("ES", "NQ", "CL", "GC"):
        row = w.futures_row(root)
        last, change, high, low = prices.get(root, (None, None, None, None))
        rows.append(
            {
                "root": row["root"],
                "front": row["front"],
                "last": last,
                "change_pct": change,
                "week_high": high,
                "week_low": low,
                "next_roll": row["next_roll"],
                "expiry": row["expiry"],
                "stamp": stamp() if last is not None else unavailable_stamp(),
            }
        )
    return {"rows": rows, "macro_week": list(_MACRO_WEEK)}


def alert(
    template: str,
    enabled: bool | None = None,
    rules: dict[str, float | bool] | None = None,
    scope: str | dict[str, int] | None = None,
) -> dict[str, Any]:
    """The template as it reads after a change; the stub stores nothing, so a GET always shows the defaults."""
    return {
        "template": template,
        "enabled": (template != "ai_daily_view") if enabled is None else enabled,
        "scope": scope or "holdings",
        "rules": {**ALERT_RULES[template], **(rules or {})},
        "strategy_id": _STRATEGY_ID[template],
    }


def alert_problems(template: str, rules: dict[str, float | bool] | None) -> list[dict[str, str]]:
    """The 422 body's problems: a rule the template has no use for, or a number where a switch belongs and back."""
    known = ALERT_RULES[template]
    problems = []
    for key, value in (rules or {}).items():
        if key not in known:
            problems.append({"path": f"rules.{key}", "message": "is not a rule of this template"})
        elif isinstance(value, bool) != isinstance(known[key], bool):
            problems.append(
                {
                    "path": f"rules.{key}",
                    "message": "must be true or false" if isinstance(known[key], bool) else "must be a number",
                }
            )
    return problems


def alerts() -> list[dict[str, Any]]:
    return [alert(template) for template in ALERT_RULES]


def watchlist_fundamentals(symbol: str) -> dict[str, Any]:
    """A `long_term` watchlist row's `fundamentals`: the world's metrics for a symbol it knows, all null otherwise."""
    return holdings.fundamentals(symbol) if symbol in w.QUOTES else {}
