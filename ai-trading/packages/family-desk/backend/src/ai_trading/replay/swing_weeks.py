"""The weekly review of a swing thread, wired to the stored facts (02p §e). `week.py` is the pure arithmetic; this
module gathers its inputs, stores the frozen review and serves the holds, weeks and week reads.

- **Nothing later than the review's close.** `build_inputs(..., through_day=D)` reads the day summaries of the ended
  days up to D, the split-adjusted closes up to D, and each hold AS OF D: a hold that left after D is open in D's
  review and is valued from D's own summary snapshot (its row has since been marked, restated or closed). The result
  is the same whatever the bars, the exits and the splits after D look like (the tests replace them).
- **Frozen once.** The last day's `end` freezes the week through that day; an early thread close freezes the partial
  week through the last ended day. A closed week serves its stored review. The open week serves "Week to date": the
  same function through the last ended close, computed on every read and never stored.
- **Prices.** A hold's prices are on the share basis of the day they were last restated to (its exit day if closed,
  else the review's close); `week.to_adjusted` moves them onto the basis of the split-adjusted closes with that day's
  raw and adjusted close.

- **An early close** exits the open holds at the last ended close after that day's summary was stored, so the last
  day's facts move their P/L from unrealized to realized (the week then agrees with the ledger and the balance).

Ceilings (not modeled): a stop crossing she answered by moving the stop is not a stop event (the move clears the
flag, so no record is left); an away crossing with no later watched day yet (the week's last day, say) is left out of
the honored count and never added to it by the next week.
"""

import logging
from dataclasses import dataclass, replace
from datetime import date, datetime
from typing import Any

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import et, previous_session
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import PracticeHold, PracticePlan, PracticeThread, PracticeWeek, ReplayDayList, ReplaySession
from ai_trading.replay import hold_rows, journal, signals, swing
from ai_trading.replay import holds as holds_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay import week as week_mod
from ai_trading.replay.session import ReplayProblem, Services, jsonable

log = logging.getLogger(__name__)

NOTES_MAX = 2000
STATUSES = ("open", "closed", "all")


# -- the inputs ---------------------------------------------------------------------------------------------------


@dataclass
class _Week:
    """What the builders below read, loaded once for one review."""

    db: Session
    svc: Services
    store: Any
    days: list[date]  # the thread's days through the review's close
    number: dict[date, int]
    through: date
    span: week_mod.WeekSpan
    ended: list[ReplayDayList]  # the ended days through the review's close, in order
    journals: dict[date, dict[str, Any]]  # their day summaries
    rows: list[PracticeHold]  # every hold of the thread, in entry order
    frames: dict[str, pd.DataFrame]  # split-adjusted dailies of the universe and SPY (the whole thread)

    def ratio(self, symbol: str, day: date) -> float:
        """`to_adjusted`'s factor on `day`: the adjusted close over the raw close."""
        raw = self.svc.history.daily_bars(self.store, symbol, day)
        return float(self.frames[symbol].loc[day, "close"]) / float(raw.loc[day, "close"])


def _ended(db: Session, plan: PracticePlan, through_day: date) -> list[ReplayDayList]:
    return list(
        db.execute(
            select(ReplayDayList)
            .where(ReplayDayList.plan_id == plan.id, ReplayDayList.status == "ended", ReplayDayList.day <= through_day)
            .order_by(ReplayDayList.day)
        ).scalars()
    )


def _day_facts(w: _Week) -> list[week_mod.DayFact]:
    facts = []
    for r in w.ended:
        j = w.journals[r.day]
        facts.append(
            week_mod.DayFact(
                day=r.day,
                passed=j["passed"] == "yes",
                entries=j["entries"],
                exits=j["exits"],
                realized_usd=j["realized_usd"],
                gap_usd=j["gap_usd"],
                intraday_usd=j["intraday_usd"],
                unrealized_change_usd=j["unrealized_change_usd"],
                balance_usd=j["balance_usd"],
                equity_usd=j["equity_usd"],
                max_open_seen=j["max_open_seen"],
            )
        )
    # An early thread close exits the open holds at the last ended close AFTER that day's summary was stored (which
    # still lists them open). Move their P/L from unrealized to realized so the week agrees with the ledger.
    listed_open = {s["id"] for s in w.journals[w.through]["holds"] if s["status"] == "open"}
    early = [
        holds_mod.closed_pnl(hold_rows.to_hold(r))
        for r in w.rows
        if r.status == "closed" and r.exit_source == "auto" and r.exit_day == w.through and r.id in listed_open
    ]
    if early:
        last, paid = facts[-1], sum(early)
        facts[-1] = replace(
            last,
            exits=last.exits + len(early),
            realized_usd=round(last.realized_usd + paid, 2),
            unrealized_change_usd=round(last.unrealized_change_usd - paid, 2),
            balance_usd=round(last.balance_usd + paid, 2),
        )
    return facts


def _closes(w: _Week, basis: date, symbols: list[str]) -> dict[str, pd.Series]:
    """Split-adjusted closes from the basis day (the close before Day 1) through the review's close, one per symbol."""
    out = {}
    for symbol in symbols:
        close = w.frames[symbol]["close"]
        out[symbol] = close[[basis <= d <= w.through for d in close.index]]
    return out


def _price_day(h: holds_mod.Hold) -> date:
    """The session whose share basis a CLOSED hold's prices are on: its exit day (a split restated them to it). A hold a
    reverse split rounded down to 0 shares closed flat on the pre-split basis, so its basis is the session before."""
    assert h.exit_day is not None
    last = h.splits[-1] if h.splits else None
    if last is not None and last["shares_after"] == 0 and last["day"] == h.exit_day.isoformat():
        return previous_session("stock", h.exit_day)
    return h.exit_day


def _stops(w: _Week, interval: int) -> tuple[list[tuple[int, bool]], dict[int, str]]:
    """The week's stop crossings, from the day summaries: `(hold_id, honored)` for each one that can be judged, and a
    label per hold that had one ("honored", "away", or "set" for one she watched and did not answer in time).

    Honored (02p e3): she exited within one display bar of the first moment she could act, which is the crossing itself
    when she watched and the first regular bar of her next watched day when she was away. An away crossing with no
    later watched day yet cannot be judged and is not counted."""
    watched_days = [r.day for r in w.ended if w.journals[r.day]["passed"] == "no"]
    window = pd.Timedelta(minutes=interval)
    events: list[tuple[int, bool]] = []
    labels: dict[int, str] = {}
    for r in w.ended:
        if r.day < w.span.days[0]:
            continue
        for hit in w.journals[r.day]["stop_hits"]:
            at = et(r.day, hit["at"])
            mine = [
                h
                for h in w.rows
                if h.symbol == hit["symbol"]
                and h.entry_day <= r.day
                and (h.exit_day is None or h.exit_day >= r.day)
                and pd.Timestamp(h.entry_at) <= at
            ]
            if not mine:
                continue
            row = max(mine, key=lambda h: h.entry_at)
            if hit["watched"] == "yes":
                since = at
            else:
                after = next((d for d in watched_days if d > r.day), None)
                if after is None:
                    labels[row.id] = "away"
                    continue
                since = trading_session("stock", after).regular_open
            honored = (
                row.exit_source == "her"
                and row.exit_at is not None
                and row.exit_day <= w.through
                and since <= pd.Timestamp(row.exit_at) <= since + window
            )
            events.append((row.id, honored))
            labels[row.id] = "honored" if honored else "away" if hit["watched"] == "no" else "set"
    return events, labels


def _holds(w: _Week, labels: dict[int, str]) -> list[week_mod.HoldFact]:
    """Every hold with a day in the week, as of the review's close (see the module docstring)."""
    first = w.span.days[0]
    out = []
    for row in w.rows:
        if row.entry_day > w.through or (row.exit_day is not None and row.exit_day < first):
            continue
        h = hold_rows.to_hold(row)
        if row.status == "closed" and row.exit_day <= w.through:
            day, exit_day, exit_price = _price_day(h), h.exit_day, h.exit_price
            shares, entry, pnl, r = (
                h.shares,
                h.entry_price,
                holds_mod.closed_pnl(h),
                holds_mod.r_multiple(h, exit_price),
            )
            stops = (h.stop_at_entry, h.stop_price)
        else:  # open at the close: that day's summary holds the hold as it stood (the row may have moved on since)
            snap = {s["id"]: s for s in w.journals[w.through]["holds"]}[row.id]
            day, exit_day, exit_price = w.through, None, None
            shares, entry, pnl, r = snap["shares"], snap["entry_price"], snap["unrealized_usd"], snap["r"]
            stops = (snap["stop_at_entry"], snap["stop_price"])
        gaps = [
            s["gap_usd"]
            for d in w.days
            if d >= first
            for s in w.journals[d]["holds"]
            if s["id"] == row.id and s["gap_usd"] is not None
        ]
        factor = w.ratio(row.symbol, day)
        out.append(
            week_mod.HoldFact(
                id=row.id,
                symbol=row.symbol,
                side=row.side,
                shares=shares,
                entry_day=row.entry_day,
                entry_price=entry,
                entry_price_adj=entry * factor,
                exit_day=exit_day,
                exit_price=exit_price,
                exit_price_adj=None if exit_price is None else exit_price * factor,
                pnl_usd=pnl,
                gap_usd=round(sum(gaps), 2) if gaps else None,
                r=r,
                stop=labels.get(row.id) or ("set" if any(s is not None for s in stops) else "none"),
            )
        )
    return out


def _entries(w: _Week, flags: dict[date, list[str]], interval: int) -> list[week_mod.EntryFact]:
    """One fact per hold opened in the week: the plan checks of 02p e3 that are about an entry."""
    first = w.span.days[0]
    mine = [r for r in w.rows if first <= r.entry_day <= w.through]
    ids = [r.entry_session_id for r in mine if r.entry_session_id is not None]
    fires = {
        sid: signals.load_fires(rows)
        for sid, rows in w.db.execute(select(ReplaySession.id, ReplaySession.signals).where(ReplaySession.id.in_(ids)))
    }
    window = pd.Timedelta(minutes=journal.ON_SIGNAL_BARS * interval)
    boards = {r.day: r for r in w.ended}
    out = []
    for row in mine:
        at = pd.Timestamp(row.entry_at)
        starred = row.symbol in {x["symbol"] for x in boards[row.entry_day].watch}
        late = row.symbol in w.journals[row.entry_day]["late_stars"]
        held = any(  # she had the name already: it exited earlier the same day, or the day before it came in
            o.symbol == row.symbol
            and o.entry_at < row.entry_at
            and o.exit_day is not None
            and o.exit_day >= row.entry_day
            for o in w.rows
        )
        realized = sum(
            holds_mod.closed_pnl(hold_rows.to_hold(o))
            for o in w.rows
            if o.status == "closed"
            and o.exit_day is not None
            and first <= o.exit_day <= w.through
            and o.exit_at <= row.entry_at
        )
        out.append(
            week_mod.EntryFact(
                hold_id=row.id,
                symbol=row.symbol,
                day_no=w.number[row.entry_day],
                had_stop=row.stop_at_entry is not None,
                risk_usd=None
                if row.stop_at_entry is None
                else row.shares * abs(float(row.entry_price) - float(row.stop_at_entry)),
                on_signal=row.symbol in flags.get(row.entry_day, ())
                or any(journal.timedelta_ok(at - f.bar_close, window) for f in fires.get(row.entry_session_id, ())),
                focused_before_open=(starred and not late) or held,
                week_realized_before=round(realized, 2),
            )
        )
    return out


def _week_plan(thread: PracticeThread, plan: PracticePlan) -> week_mod.WeekPlan:
    """R1: the thread's plan fields under the 02p names (loss and trade limits count per week) and the swing spec's."""
    return week_mod.WeekPlan(
        stop_required=thread.stop_note_on_entry == "yes",
        risk_per_hold_usd=plan.spec.get("riskPerHoldUsd"),
        max_open_holds=plan.spec["maxOpenHolds"],
        max_loss_usd=thread.max_loss_usd,
        max_trades=thread.max_trades,
        signal_only=thread.trade_only_on_signal == "yes",
    )


def build_inputs(
    db: Session, svc: Services, thread: PracticeThread, plan: PracticePlan, week_no: int, *, through_day: date
) -> week_mod.ReviewInputs:
    """The pure review's inputs for week `week_no`, from stored facts with nothing later than `through_day`'s close (the
    week's last day for a frozen week, the last ended day for "Week to date")."""
    planned = swing._days(plan)
    days = [d for d in planned if d <= through_day]
    store = svc.store_factory(db)
    universe = plan.universe["symbols"]
    symbols = [entry["symbol"] for entry in universe]
    ended = _ended(db, plan, through_day)
    w = _Week(
        db=db,
        svc=svc,
        store=store,
        days=days,
        number={d: n for n, d in enumerate(days, start=1)},
        through=through_day,
        span=next(s for s in week_mod.week_spans(days) if s.week_no == week_no),
        ended=ended,
        journals={r.day: r.journal for r in ended},
        rows=hold_rows.load(db, thread.id),
        frames={
            s: swing.split_frame(svc.history, store, s, planned[0], planned[-1]) for s in (*symbols, swing.BENCHMARK)
        },
    )
    interval = int(plan.spec["interval"].removesuffix("m"))
    basis = date.fromisoformat(plan.universe["basis_day"])
    events, labels = _stops(w, interval)
    in_week = [r for r in ended if r.day >= w.span.days[0]]
    flags = {r.day: matched for r in in_week if (matched := [c["symbol"] for c in r.candidates if c["matches"]])}
    focus: dict[str, date] = {}
    for r in in_week:
        for star in r.watch:
            focus.setdefault(star["symbol"], r.day)
    closes = _closes(w, basis, [*symbols, swing.BENCHMARK])
    return week_mod.ReviewInputs(
        days=days,
        basis_day=basis,
        week_no=week_no,
        plan=_week_plan(thread, plan),
        day_facts=_day_facts(w),
        holds=_holds(w, labels),
        entries=_entries(w, flags, interval),
        closes={s: closes[s] for s in symbols},
        sources={entry["symbol"]: entry["source"] for entry in universe},
        stop_events=events,
        benchmark=closes[swing.BENCHMARK],
        focus=focus,
        flags=flags,
    )


# -- the review ---------------------------------------------------------------------------------------------------


def _span(plan: PracticePlan, week_no: int) -> week_mod.WeekSpan:
    return next(s for s in week_mod.week_spans(swing._days(plan)) if s.week_no == week_no)


def _label(span: week_mod.WeekSpan, played: int) -> str:
    """ "Week 3", "Week 1 · 3 days", or "Week 3 · 2 of 5 days" for a week not played to its planned end."""
    return span.label if played == len(span.days) else f"Week {span.week_no} · {played} of {len(span.days)} days"


def _review(
    db: Session, svc: Services, thread: PracticeThread, plan: PracticePlan, week_no: int, through_day: date
) -> dict[str, Any]:
    review = week_mod.compute_review(build_inputs(db, svc, thread, plan, week_no, through_day=through_day))
    span = _span(plan, week_no)
    review["week"]["label"] = _label(span, sum(1 for d in span.days if d <= through_day))
    return review


def freeze(
    db: Session, svc: Services | None, thread: PracticeThread, plan: PracticePlan, week_no: int, now: datetime
) -> None:
    """Close the week row with its review, built through the week's last day (an early close has set it to the last
    ended day). Called by the lifecycle when a week's last day ends and when the thread closes early. Without `svc`
    the row closes without a review and `week_out` builds it on read. A review that fails never blocks the day: it is
    logged and the week closes without one."""
    week = db.get(PracticeWeek, (thread.id, week_no))
    if week is None or week.status == "closed":
        return
    review = None
    if svc is not None:
        try:
            review = jsonable(_review(db, svc, thread, plan, week_no, week.last_day))
        except Exception:  # noqa: BLE001 -- ending a day must not fail over its review
            log.exception("swing week %s review failed", week_no)
    week.status, week.closed_at, week.review = "closed", now, review
    db.flush()


def _week_row(db: Session, thread: PracticeThread, week_no: int, *, lock: bool = False) -> PracticeWeek:
    row = db.get(PracticeWeek, (thread.id, week_no), with_for_update=lock)
    if row is None:
        raise ReplayProblem(f"Week {week_no} has not started yet", path="week", status=404)
    return row


def week_out(db: Session, svc: Services, thread: PracticeThread, week_no: int) -> dict[str, Any]:
    """`GET .../weeks/{n}`: a closed week serves its stored review; the open one serves "Week to date" through the last
    ended close. A week not opened, or opened with no ended day yet, is a 404."""
    week = _week_row(db, thread, week_no)
    plan = swing._thread_plan(db, thread.id)
    if week.status == "closed":
        through, to_date = week.last_day, "no"
    else:
        through, to_date = _last_ended(db, plan), "yes"
        if through is None or through < week.first_day:
            raise ReplayProblem(f"Week {week_no} has no finished day yet · end a day first", path="week", status=404)
    review = (
        week.review if to_date == "no" and week.review is not None else _review(db, svc, thread, plan, week_no, through)
    )
    return {
        "week_no": week_no,
        "label": review["week"]["label"],
        "status": week.status,
        "to_date": to_date,
        "review": review,
        "notes": week.notes,
        "rating": week.rating,
        "universe_label": swing.survivorship_label(len(plan.universe["symbols"])),
        "footnote": swing.DIVIDEND_NOTE,
    }


def _last_ended(db: Session, plan: PracticePlan) -> date | None:
    return db.execute(
        select(func.max(ReplayDayList.day)).where(ReplayDayList.plan_id == plan.id, ReplayDayList.status == "ended")
    ).scalar_one()


def weeks_out(db: Session, thread: PracticeThread) -> dict[str, Any]:
    """`GET .../weeks`: one row per week opened so far. The figures come from the stored review of a closed week; an
    open week has none here (its "Week to date" is `week_out`'s)."""
    plan = swing._thread_plan(db, thread.id)
    days = swing._days(plan)
    number = {d: n for n, d in enumerate(days, start=1)}
    spans = {s.week_no: s for s in week_mod.week_spans(days)}
    rows = db.execute(
        select(PracticeWeek).where(PracticeWeek.thread_id == thread.id).order_by(PracticeWeek.week_no)
    ).scalars()
    weeks = []
    for week in rows:
        span = spans[week.week_no]
        shown = [d for d in span.days if week.first_day <= d <= week.last_day]
        review = week.review or {}
        tiles = review.get("tiles", {})
        weeks.append(
            {
                "week_no": week.week_no,
                "label": _label(span, len(shown)),
                "days": len(shown),
                "first_day_no": number[shown[0]],
                "last_day_no": number[shown[-1]],
                "status": week.status,
                "realized_usd": tiles.get("realized_usd"),
                "equity_change_usd": tiles.get("equity_change_usd"),
                "adherence_pct": tiles.get("adherence_pct"),
                "selection_pts": tiles.get("selection_pts"),
                "timing_pts": tiles.get("timing_pts"),
            }
        )
    return {"thread_id": thread.id, "weeks": weeks, "label": threads_mod.SIMULATED_LABEL}


def patch_week(
    db: Session,
    thread: PracticeThread,
    week_no: int,
    *,
    notes: str | None,
    rating: int | None,
    fields: set[str],
    now: datetime,
) -> PracticeWeek:
    """Notes and rating only, while the week is open or closed; a field not in `fields` is left alone and one sent as
    null is cleared. (`now` is part of the shared patch signature; the week row keeps no update stamp.)"""
    week = _week_row(db, thread, week_no, lock=True)
    if "notes" in fields:
        if notes is not None and len(notes) > NOTES_MAX:
            raise ReplayProblem(f"Notes can be at most {NOTES_MAX:,} characters", path="notes")
        week.notes = notes
    if "rating" in fields:
        if rating is not None and not 1 <= rating <= 5:
            raise ReplayProblem("Rate the week from 1 to 5", path="rating")
        week.rating = rating
    db.flush()
    return week


def holds_out(db: Session, svc: Services, thread: PracticeThread, status: str) -> dict[str, Any]:
    """`GET .../holds?status=`: the thread's holds. An open hold is valued at its last official close, which is the last
    ENDED day's (a later bar is never read: only the stored `last_close` is). `as_of_day_no` is that day (None before
    any day has ended)."""
    if status not in STATUSES:
        raise ReplayProblem("Status is open, closed or all", path="status")
    plan = swing._thread_plan(db, thread.id)
    days = swing._days(plan)
    last = _last_ended(db, plan)
    latest = plan_mod._latest(db, plan.id)
    chips = {} if latest is None else {c["symbol"]: c.get("earnings") for c in latest.candidates}
    holds = [
        swing.hold_view(
            row,
            days,
            # a hold entered on the day under way has no close yet: its days held run through its entry day
            as_of=row.entry_day if last is None or row.entry_day > last else last,
            chip=chips.get(row.symbol),
            price_basis="prior_close",
            split_day=None if latest is None else latest.day,
        )
        for row in hold_rows.load(db, thread.id, None if status == "all" else status)
    ]
    return {
        "thread_id": thread.id,
        "as_of_day_no": None if last is None else days.index(last) + 1,
        "holds": holds,
        "label": threads_mod.SIMULATED_LABEL,
    }


__all__ = ("build_inputs", "freeze", "holds_out", "patch_week", "week_out", "weeks_out")
