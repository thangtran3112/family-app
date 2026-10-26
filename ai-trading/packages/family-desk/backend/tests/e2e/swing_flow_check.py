"""Explicit-runner-only: a swing thread through the real API over real HTTP (02p), against the E2E swing world.

Run by `run.py` after the browser suite (or alone with `run.py --checks`), in its own disposable database. The real
server prepares the thread's bars in a background task and the E2E lifespan serves the scripted world of
`swing_services.py`, so this walks what the Playwright spec walks, without a browser:

    preview the universe -> create the thread -> wait for the prep -> Day 1: star S01, start a session, enter a long
    with a stop -> End day (the hold stays open overnight) -> Pass Days 2 and 3 -> Day 4, the morning S01 gaps up 6%:
    the carried hold shows its gap, she exits -> End day (the P/L is credited) -> read the holds, the weeks and the
    ledger, take notes on the week, close the thread.
"""

import time
from datetime import date

import httpx
from http_check import real_servers  # noqa: F401  (the fixture: real API and proxy on loopback)
from swing_world import DAYS, FIRST_DAY, GAP_UP_DAY, SYMBOLS, swing_setup  # on the path since `server` was imported

from ai_trading.core.calendar import et

SESSION = {"cookie": "desk_e2e_session=1"}
ENTRY_SHARES = 100
STOP = 95.0


def _utc(day: date, hhmm: str) -> str:
    return et(day, hhmm).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _ok(response: httpx.Response, status: int = 200) -> dict:
    assert response.status_code == status, f"{response.request.method} {response.request.url}: {response.text}"
    return response.json()


def _wait_for_prep(client: httpx.Client, thread_id: int, timeout: float = 90.0) -> int:
    """`POST /daily/next` answers no list while the background prep runs; the first answer with a list is Day 1."""
    deadline = time.monotonic() + timeout
    while True:
        opened = _ok(client.post("/daily/next", json={"threadId": thread_id}))
        if opened["day_list_id"] is not None:
            return opened["day_list_id"]
        assert opened["plan"]["prep"]["state"] == "running", opened
        assert time.monotonic() < deadline, "the swing prep did not finish"
        time.sleep(0.25)


def _end_day(client: httpx.Client, day_list_id: int) -> dict:
    return _ok(client.post(f"/day-lists/{day_list_id}/end"))


def _open_next(client: httpx.Client, thread_id: int) -> int:
    opened = _ok(client.post("/daily/next", json={"threadId": thread_id}))
    assert opened["kind"] == "swing" and opened["day_list_id"] is not None
    return opened["day_list_id"]


def test_a_swing_thread_runs_through_the_real_api(real_servers) -> None:  # noqa: F811
    _, proxy_origin = real_servers
    with httpx.Client(base_url=f"{proxy_origin}/api/desk/replay", headers=SESSION, timeout=30) as client:
        # the preview: the twelve scripted stocks, all her own picks, nothing saved
        request = {
            "first_day": FIRST_DAY.isoformat(),
            "sessions": 15,
            "fill": "none",
            "add": SYMBOLS,
            "target": 12,
        }
        preview = _ok(client.post("/threads/swing-universe", json=request))
        assert preview["state"] == "ready" and preview["pending_symbols"] == 0
        assert [row["symbol"] for row in preview["rows"]] == SYMBOLS and preview["excluded"] == []
        assert "12 symbols" in preview["label"] and _ok(client.get("/threads")) == []

        # create it: the universe frozen as the preview showed it
        setup = swing_setup(universe=[{"symbol": row["symbol"], "source": row["source"]} for row in preview["rows"]])
        plan = {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}
        body = {"schemaVersion": 1, "mode": "swing", "startingBalance": 50_000, "plan": plan, "swing": setup}
        created = _ok(client.post("/threads", json=body))
        thread_id = created["thread"]["id"]
        assert created["thread"]["swing"]["firstDay"] == FIRST_DAY.isoformat()
        assert created["swing"]["next"] == "day" and created["swing"]["free_cash_usd"] == 50_000

        # Day 1: star S01, practise it, enter a long with a stop, End day
        day_one = _wait_for_prep(client, thread_id)
        board = _ok(client.get(f"/day-lists/{day_one}"))
        assert board["kind"] == "swing" and len(board["candidates"]) == 12 and board["holds"] == []
        _ok(client.patch(f"/day-lists/{day_one}", json={"watch": ["S01"]}))
        session = _ok(client.post(f"/day-lists/{day_one}/sessions", json={"symbol": "S01"}))["id"]
        _ok(client.post(f"/sessions/{session}/advance", json={"to": _utc(DAYS[0], "10:00")}))
        entered = _ok(
            client.post(
                f"/sessions/{session}/marks",
                json={"schemaVersion": 1, "kind": "long_entry", "shares": ENTRY_SHARES, "stopPrice": STOP},
            )
        )
        hold = entered["hold"]
        assert hold["symbol"] == "S01" and hold["status"] == "open" and hold["stop_price"] == STOP
        ended = _end_day(client, day_one)
        assert ended["status"] == "ended" and ended["journal"]["entries"] == 1
        assert [h["symbol"] for h in ended["journal"]["holds"]] == ["S01"]  # it stays open overnight

        # Days 2 and 3: nothing to do, Pass
        for _ in range(2):
            passed = _end_day(client, _open_next(client, thread_id))
            assert passed["journal"]["passed"] == "yes" and passed["journal"]["holds"][0]["status"] == "open"

        # Day 4: S01 gaps up 6% at the open; she is still long
        assert DAYS[3] == GAP_UP_DAY
        day_four = _open_next(client, thread_id)
        board = _ok(client.get(f"/day-lists/{day_four}"))
        assert board["day_no"] == 4 and [h["days_held"] for h in board["holds"]] == [3]
        session = _ok(client.post(f"/day-lists/{day_four}/sessions", json={"symbol": "S01"}))["id"]
        moved = _ok(client.post(f"/sessions/{session}/advance", json={"to": _utc(GAP_UP_DAY, "09:35")}))
        trade = moved["open_trade"]
        assert "paused" not in moved and trade["days_held"] == 4 and trade["opened_day_no"] == 1
        assert trade["gap_usd"] > 0 and trade["price_basis"] == "last"
        assert moved["strip"][0]["symbol"] == "S01" and moved["strip"][0]["hold"]["stopped"] == "no"
        closed = _ok(client.post(f"/sessions/{session}/marks", json={"schemaVersion": 1, "kind": "long_exit"}))
        assert closed["hold"]["status"] == "closed" and closed["hold"]["pnl_usd"] > 0
        summary = _end_day(client, day_four)["journal"]
        assert summary["exits"] == 1 and summary["realized_usd"] > 0 and summary["gap_usd"] > 0

        # the reads: holds, weeks, the ledger and the thread
        holds = _ok(client.get(f"/threads/{thread_id}/holds?status=closed"))
        assert [h["id"] for h in holds["holds"]] == [hold["id"]] and holds["as_of_day_no"] == 4
        assert _ok(client.get(f"/threads/{thread_id}/holds?status=open"))["holds"] == []
        weeks = _ok(client.get(f"/threads/{thread_id}/weeks"))["weeks"]
        assert [(w["week_no"], w["status"]) for w in weeks] == [(1, "open")]
        week = _ok(client.get(f"/threads/{thread_id}/weeks/1"))
        assert week["to_date"] == "yes" and week["review"]["tiles"]["realized_usd"] > 0
        assert [d["day_no"] for d in week["review"]["days"]] == [1, 2, 3, 4]
        assert week["review"]["tiles"]["spy_return_pct"] is not None  # the benchmark was prepared with the universe
        noted = _ok(client.patch(f"/threads/{thread_id}/weeks/1", json={"notes": "Held through the gap.", "rating": 5}))
        assert (noted["notes"], noted["rating"]) == ("Held through the gap.", 5)
        ledger = _ok(client.get(f"/threads/{thread_id}/ledger"))
        assert ledger["total"] == 1 and ledger["entries"][0]["holdId"] == hold["id"]
        thread = _ok(client.get(f"/threads/{thread_id}"))
        assert thread["swing"]["days_ended"] == 4 and thread["thread"]["stats"]["balance"] > 50_000

        # closing early freezes the week with what was played
        closed_thread = _ok(client.post(f"/threads/{thread_id}/close"))
        assert closed_thread["thread"]["status"] == "closed" and closed_thread["swing"]["next"] == "finished"
        frozen = _ok(client.get(f"/threads/{thread_id}/weeks"))["weeks"][0]
        assert (frozen["status"], frozen["days"]) == ("closed", 4) and frozen["realized_usd"] > 0
