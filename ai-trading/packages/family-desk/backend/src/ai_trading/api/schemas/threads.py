"""Response models for the practice threads of `/api/desk/replay/threads` (02r).

What she authors (`PracticeThreadCreateV1`, `PracticeThreadPatchV1`) and what the server reads back
(`PracticeThreadV1`, `PracticeLedgerEntryV1`) are contracts (`ai_trading.contracts.practice_thread`); the rest is
plain Pydantic. Every dollar figure is SIMULATED: `label` says so in words wherever a balance travels.
"""

from datetime import date, datetime
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, FiniteFloat, field_serializer, model_validator

from ai_trading.api.schemas.common import SwingOptional
from ai_trading.contracts.practice_thread import PracticeLedgerEntryV1, PracticeThreadV1

ThreadMode = Literal["day", "swing"]
ThreadStatus = Literal["active", "closed"]
Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri"]


class ThreadBriefOut(SwingOptional):
    """The header strip of a day screen or the workspace: the SIMULATED balance and today's realized P/L (null when no
    practice day is under way; an open trade is not realized). A swing thread adds its equity, free cash and where it
    is in its calendar (02p); a day thread leaves those null."""

    id: int
    mode: ThreadMode
    status: ThreadStatus
    balance: FiniteFloat
    today_pnl_usd: FiniteFloat | None
    label: str
    swing_only: ClassVar[tuple[str, ...]] = ("equity_usd", "free_cash_usd", "day_no", "days", "week_no")

    equity_usd: FiniteFloat | None = None  # balance plus the open holds at their last official close
    free_cash_usd: FiniteFloat | None = None
    day_no: int | None = None
    days: int | None = None
    week_no: int | None = None


class ThreadTodayOut(BaseModel):
    """The practice day under way and what it has realized so far."""

    day_list_id: int
    day: date
    weekday: Weekday
    day_no: int
    status: Literal["listed", "practicing"]
    trades: int
    pnl_usd: FiniteFloat


class SwingEquityPointOut(BaseModel):
    """One ended swing day of the equity series: numbers and a weekday only, no dates (the web hides them)."""

    day_no: int
    weekday: Weekday
    balance_usd: FiniteFloat
    equity_usd: FiniteFloat


class SwingStateOut(BaseModel):
    """Where a swing thread is (02p f2): the day under way (else the next to open), its week, the open holds with free
    cash and equity, and the equity series, which stops at the last ended day. All SIMULATED."""

    day_no: int
    days: int
    days_ended: int
    week_no: int
    weeks: int
    holds_open: int
    free_cash_usd: FiniteFloat
    equity_usd: FiniteFloat
    equity_series: list[SwingEquityPointOut]
    next: Literal["day", "week_review", "finished"]


class ThreadDayOut(BaseModel):
    """One ended practice day, in the order she practised. `balance` is the SIMULATED balance at the day's end."""

    n: int  # 1-based over the thread's ended days
    day_list_id: int
    day: date
    weekday: Weekday
    kind: Literal["practiced", "skipped"]  # skipped: the day ended with no session, the balance carried
    trades: int
    pnl_usd: FiniteFloat
    adherence_pct: int | None
    balance: FiniteFloat


class ThreadSummaryOut(SwingOptional):
    """A thread with its plan and stats (the contract), and today. A row of the hub's "Your threads" list. A swing
    thread also carries its `swing` state (its setup is `thread.swing`, the contract's echo)."""

    swing_only: ClassVar[tuple[str, ...]] = ("swing",)

    thread: PracticeThreadV1
    today: ThreadTodayOut | None
    last_day: (
        ThreadDayOut | None
    )  # the last ended day, from the same series as the balance: the card's row with no day open
    last_activity_at: datetime | None  # wall-clock UTC of the last day list, day end or week review; null while fresh
    label: str
    swing: SwingStateOut | None = None

    @field_serializer("thread")
    def _thread_as_authored(
        self, thread: PracticeThreadV1
    ):  # no return annotation: the schema stays `PracticeThreadV1`
        """An empty stat or an unset limit is absent, never null (the Zod contract does not accept null there)."""
        return thread.model_dump(mode="json", by_alias=True, exclude_none=True)


class CurvePointOut(BaseModel):
    """A point of the balance curve: `n` 0 is the starting balance (no day), then one per ended day."""

    n: int
    day: date | None
    balance: FiniteFloat


class ThreadOut(ThreadSummaryOut):
    daily: list[ThreadDayOut]
    curve: list[CurvePointOut]


class FillOut(BaseModel):
    """One execution of a day thread: a Buy or a Sell with its shares, price and time. `closes` of the shares closed the
    name's position and `opens` opened or added to one (a flip has both)."""

    id: int
    session_id: int
    symbol: str
    day: date
    action: Literal["buy", "sell"]
    shares: int
    price: FiniteFloat
    at: datetime
    closes: int
    opens: int
    trade_no: int | None
    source: Literal["her", "auto"]


class ThreadFillsOut(BaseModel):
    """The newest executions of a day thread, newest booking first. `total` counts every one."""

    thread_id: int
    total: int
    fills: list[FillOut]


class ClockAccountOut(BaseModel):
    """The simulated account at the clock: the ledger's `balance` (realized), what every open position is worth over its
    cost at the clock (`open_pnl_usd`), and `equity_usd`, the two together. Computed on the server, never past the
    clock."""

    balance: FiniteFloat
    open_pnl_usd: FiniteFloat
    equity_usd: FiniteFloat
    day_pnl_usd: FiniteFloat
    positions: int
    as_of: datetime


class ThreadClockOut(BaseModel):
    """The day-trade thread's clock (ADR-0018). `clock` is the simulated time at `server_now` (a running clock was
    settled before this was built); a client may extrapolate it with `speed` between polls but never owns it."""

    thread_id: int
    state: Literal["no_day", "listed", "paused", "running"]
    day_list_id: int | None
    day_no: int | None
    running: bool
    speed: Literal[1, 2, 5, 10]
    clock: datetime | None
    window_start: datetime | None
    window_end: datetime | None  # the exchange close: the only time the clock ends on its own
    focus_end: datetime | None  # where her plan's practice window ends: a mark on the timeline, never a stop
    server_now: datetime
    account: ClockAccountOut | None
    label: str


class ClockIn(BaseModel):
    """Play or pause (`running`), the speed, and a step or jump (`step` one bar or to the next signal; `to` a time with
    its UTC offset). Any mix, at least one; a step or jump is forward only and stops at the close."""

    model_config = ConfigDict(extra="forbid")

    running: bool | None = None
    speed: Literal[1, 2, 5, 10] | None = None
    step: Literal["bar", "next_signal"] | None = None
    to: datetime | None = None

    @model_validator(mode="after")
    def _something_to_do(self) -> "ClockIn":
        if not self.model_fields_set:
            raise ValueError("Send running, speed, step or to")
        return self


class SkipDayOut(BaseModel):
    """Skip day: the day that ended and the next one (null while its data is still being prepared, or when the plan is
    done: poll the hub), with the clock as it stands."""

    ended_day_list_id: int
    next_day_list_id: int | None
    clock: ThreadClockOut


class ThreadLedgerOut(BaseModel):
    """The newest ledger rows, newest first. `total` counts every row."""

    thread_id: int
    total: int
    entries: list[PracticeLedgerEntryV1]
    label: str

    @field_serializer("entries")
    def _entries_as_authored(self, entries: list[PracticeLedgerEntryV1]):
        return [entry.model_dump(mode="json", by_alias=True, exclude_none=True) for entry in entries]
