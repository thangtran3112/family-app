"""Stub builders for the research family (02n §c3 #12 to #15): the Desk AI brief and verdict (invented), consensus and
analyst targets, valuation and earnings reaction, and the timeline. Every Desk AI field is SIMULATED until step 5."""

from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException

from ai_trading.fundamental_stub import stamp
from ai_trading.fundamental_stub import world as w

RUN_AT = "2026-10-23T21:05:00Z"  # 17:05 ET
_RATING_WORD = {"buy": "Buy", "hold": "Hold", "sell": "Sell"}
#: One report's (move %, excess vs SPY %) per quarter, newest first; a symbol takes a rotation of it.
_REACTION = ((4.2, 3.1), (-2.8, -3.4), (6.1, 4.9), (1.3, 0.2), (-5.0, -4.1), (2.4, 1.5), (-0.9, -1.8), (3.7, 2.2))
_NEWS = {
    "AAPL": "Analysts raise targets ahead of the services update",
    "MSFT": "Cloud demand commentary lifts estimates before the report",
    "NVDA": "Supply update points to steady data-center orders",
    "KO": "Beverage volumes hold up as pricing eases",
    "JNJ": "Pharma pipeline readout expected next quarter",
}


def _known(symbol: str) -> None:
    if symbol not in w.QUOTES:
        raise HTTPException(status_code=404, detail="symbol not found")


def _target(symbol: str) -> dict[str, float]:
    low, base, high = w.verdict_target(symbol) or (0, 0, 0)
    return {"low": low, "base": base, "high": high}


def brief(on: date | None) -> dict[str, Any]:
    rows = [
        {
            "symbol": symbol,
            "rating": verdict[0],
            "prev_rating": verdict[1],
            "target": _target(symbol),
            "upside_pct": w.upside_pct(symbol),
            "confidence": verdict[5],
            "eps_rev_30d_pct": w.METRICS[symbol]["eps_rev_30d_pct"],
            "earnings_in_days": (w.QUOTES[symbol][3] - w.TODAY).days
            if (w.QUOTES[symbol][3] - w.TODAY).days <= 7
            else None,
            "stale_days": verdict[6],
        }
        for symbol, verdict in w.VERDICTS.items()
    ]
    return {
        "date": on or w.TODAY,
        "run": {"ran_at": RUN_AT, "analyzed": len(rows), "skipped": len(w.SYMBOLS) - len(rows), "cost_usd": 0.42},
        "rows": rows,
        "track_record": {"calls": 2, "settled": 0, "pending": 2},
    }


def _verdict(symbol: str) -> dict[str, Any] | None:
    verdict = w.VERDICTS.get(symbol)
    if verdict is None:
        return None
    rating, previous, _, base, _, confidence, stale = verdict
    word = _RATING_WORD[rating]
    metrics = w.METRICS[symbol]
    return {
        "rating": rating,
        "target": _target(symbol),
        "confidence": confidence,
        "reasons": [
            f"Forward P/E of {metrics['fwd_pe']:g} sits {abs(metrics['pe_vs_5y_median_pct']):g}% "
            f"{'above' if metrics['pe_vs_5y_median_pct'] > 0 else 'below'} its five-year median",
            f"Free-cash-flow yield of {metrics['fcf_yield_pct']:g}%",
            f"The base target of ${base:g} is {w.upside_pct(symbol):g}% from the last price",
        ],
        "risks": ["Earnings can reset the estimates", "A market-wide drawdown would pull the target range down"],
        "changed": "First verdict"
        if previous is None
        else (f"Unchanged: still a {word}" if previous == rating else f"Moved from {_RATING_WORD[previous]} to {word}"),
        "votes": [
            {
                "name": "Fundamentals",
                "signal": "buy" if rating == "buy" else "hold",
                "score": 0.4,
                "reasons": ["Estimates are steady"],
            },
            {"name": "Valuation", "signal": "hold", "score": 0.1, "reasons": ["Close to its own history"]},
            {
                "name": "Technicals",
                "signal": "hold" if rating != "buy" else "buy",
                "score": 0.2,
                "reasons": ["Daily bias is mild"],
            },
            {"name": "News and sentiment", "signal": "hold", "score": 0.0, "reasons": ["No headline moves the view"]},
        ],
        "bull": "Estimates keep rising and the price still trails the base target.",
        "bear": "A weak report would cut estimates and the multiple together.",
        "inputs": [
            {"name": "SEC filings", "as_of": "2026-10-16"},
            {"name": "Consensus EPS", "as_of": "2026-10-23"},
            {"name": "Daily bars", "as_of": "2026-10-23"},
            {"name": "News", "as_of": "2026-10-22"},
        ],
        "as_of": RUN_AT if stale == 0 else "2026-10-22T21:05:00Z",
        "stale_days": stale,
    }


def _consensus(symbol: str) -> dict[str, Any]:
    metrics = w.METRICS[symbol]
    earnings = w.QUOTES[symbol][3]
    price = w.last(symbol)
    eps = round(price / metrics["fwd_pe"], 2)
    return {
        "quarters": [
            {"period": "Q4 2026", "eps_estimate": round(eps / 4, 2), "analysts": 31},
            {"period": "Q1 2027", "eps_estimate": round(eps / 4 * 1.03, 2), "analysts": 29},
        ],
        "fiscal_years": [
            {"period": "FY2026", "eps_estimate": round(eps * 0.96, 2), "analysts": 36},
            {"period": "FY2027", "eps_estimate": eps, "analysts": 34},
        ],
        "surprises": [
            {
                "period": "Q3 2026",
                "actual": round(eps / 4 * 1.02, 2),
                "estimate": round(eps / 4, 2),
                "surprise_pct": 2.0,
            },
            {
                "period": "Q2 2026",
                "actual": round(eps / 4 * 0.99, 2),
                "estimate": round(eps / 4, 2),
                "surprise_pct": -1.0,
            },
        ],
        "next_earnings": {"date": earnings, "timing": "after close"},
        "revisions": {k: metrics[f"eps_rev_{k[1:]}d_pct"] for k in ("d7", "d30", "d90")},
    }


def research(symbol: str) -> dict[str, Any]:
    _known(symbol)
    price = w.last(symbol)
    return {
        "symbol": symbol,
        "verdict": _verdict(symbol),
        "consensus": _consensus(symbol),
        "targets": {
            "low": round(price * 0.82, 2),
            "mean": round(price * 1.12, 2),
            "high": round(price * 1.35, 2),
            "counts": {"buy": 24, "hold": 9, "sell": 2},
        },
        "stamp": stamp(),
    }


def valuation(symbol: str) -> dict[str, Any]:
    _known(symbol)
    price = w.last(symbol)
    metrics = w.METRICS[symbol]
    dcf, owner, ev, residual = (round(price * k, 2) for k in (1.12, 1.05, 0.96, 1.18))
    reports = 3 if symbol == "NVDA" else len(_REACTION)  # below 4 reports there is nothing to average (02h §7)
    rotation = _REACTION[w.SYMBOLS.index(symbol) % 3 :] + _REACTION[: w.SYMBOLS.index(symbol) % 3]
    series = [
        {"date": (date(2026, 7, 22) - timedelta(days=91 * i)).isoformat(), "move_pct": move, "excess_pct": excess}
        for i, (move, excess) in enumerate(rotation[:reports])
    ]
    beats = [p for p in series if p["excess_pct"] > 0]
    misses = [p for p in series if p["excess_pct"] <= 0]

    def bucket(points: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "n": len(points),
            "avg_excess_pct": round(sum(p["excess_pct"] for p in points) / len(points), 2) if points else None,
        }

    return {
        "price": price,
        "methods": [
            {
                "id": "dcf",
                "value": dcf,
                "inputs": {
                    "fcf_yield_pct": metrics["fcf_yield_pct"],
                    "growth_pct": metrics["revenue_growth_yoy_pct"],
                    "wacc_pct": 8.6,
                },
                "fallbacks": [],
            },
            {
                "id": "owner_earnings",
                "value": owner,
                "inputs": {"fcf_yield_pct": metrics["fcf_yield_pct"], "required_return_pct": 15.0},
                "fallbacks": [],
            },
            {
                "id": "ev_ebitda",
                "value": ev,
                "inputs": {"fwd_pe": metrics["fwd_pe"], "debt_to_equity": metrics["debt_to_equity"]},
                "fallbacks": ["EBITDA multiple: the sector median, no five-year history"],
            },
            {
                "id": "residual_income",
                "value": residual,
                "inputs": {"cost_of_equity_pct": 9.1, "book_value_growth_pct": 4.0},
                "fallbacks": ["Book value growth: 4% default"],
            },
        ],
        "blend": round(0.6 * dcf + 0.4 * (owner + ev + residual) / 3, 2),
        "filing_as_of": "2026-10-16",
        "earnings_reaction": None
        if reports < 4
        else {
            "reports": reports,
            "avg_abs_move_pct": round(sum(abs(p["move_pct"]) for p in series) / reports, 2),
            "avg_excess_pct": round(sum(p["excess_pct"] for p in series) / reports, 2),
            "beats": bucket(beats),
            "misses": bucket(misses),
            "series": series,
            "implied_move_pct": 4.6 if symbol in w.CHAINS else None,
        },
    }


def timeline(symbol: str, kind: str | None, limit: int, offset: int) -> dict[str, Any]:
    _known(symbol)
    earnings = w.QUOTES[symbol][3]
    items: list[dict[str, Any]] = [
        {
            "at": f"{earnings}T20:00:00Z",
            "kind": "earnings",
            "title": f"{symbol} reports earnings",
            "detail": "After the close.",
            "source": "Earnings calendar",
            "href": None,
        },
        {
            "at": "2026-10-23T20:30:00Z",
            "kind": "consensus",
            "title": "Consensus EPS snapshot taken",
            "detail": "Fiscal-year estimate unchanged on the day.",
            "source": "Desk snapshot",
            "href": None,
        },
        {
            "at": "2026-10-22T14:00:00Z",
            "kind": "news",
            "title": _NEWS[symbol],
            "detail": "Headline from the last 7 days.",
            "source": "Finnhub",
            "href": f"https://example.com/news/{symbol.lower()}",
        },
        {
            "at": "2026-10-20T13:00:00Z",
            "kind": "strategy",
            "title": "Alert 'AI daily view' turned on",
            "detail": "Fires on a rating change or a cross of the base target.",
            "source": "Desk",
            "href": None,
        },
        {
            "at": "2026-10-16T21:00:00Z",
            "kind": "filing",
            "title": "10-Q filed",
            "detail": "Quarterly report for the period ended September.",
            "source": "SEC EDGAR",
            "href": f"https://example.com/filings/{symbol.lower()}",
        },
        {
            "at": "2026-10-29T12:30:00Z",
            "kind": "macro",
            "title": "GDP, advance estimate",
            "detail": "Third quarter; moves rate-sensitive stocks.",
            "source": "FRED",
            "href": None,
        },
    ]
    if symbol in w.VERDICTS:
        items.append(
            {
                "at": RUN_AT,
                "kind": "desk_ai",
                "title": f"Desk AI: {_RATING_WORD[w.VERDICTS[symbol][0]]}",
                "detail": _verdict(symbol)["changed"],
                "source": "Desk AI",
                "href": None,
            }
        )  # type: ignore[index]
    if kind is not None:
        items = [item for item in items if item["kind"] == kind]
    items.sort(key=lambda item: datetime.fromisoformat(item["at"].replace("Z", "+00:00")), reverse=True)
    return {"items": items[offset : offset + limit], "total": len(items)}
