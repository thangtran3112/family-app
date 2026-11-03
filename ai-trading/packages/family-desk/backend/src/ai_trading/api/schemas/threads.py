"""Response models for the practice threads of `/api/desk/replay/threads` (02r, ADR-0025).

What she authors (`PracticeThreadCreateV1`, `PracticeThreadPatchV1`) and what the server reads back
(`PracticeThreadV1`, `PracticeLedgerEntryV1`) are contracts (`ai_trading.contracts.practice_thread`); the rest is
plain Pydantic. Every dollar figure is SIMULATED: `label` says so in words wherever a balance travels.
"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, FiniteFloat, field_serializer, model_validator

from ai_trading.api.schemas.common import MarketOut
from ai_trading.contracts.practice_thread import PracticeLedgerEntryV1, PracticeThreadV1

ThreadMode = Literal["day", "swing"]
ThreadStatus = Literal["active", "closed"]
Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]  # a date is a label: a mark can be made on a weekend


class ThreadBriefOut(BaseModel):
    """The header strip of a workspace: the SIMULATED balance (the ledger: realized P/L only; an open position is valued
    by the Portfolio and the clock's account)."""

    id: int
    mode: ThreadMode
    status: ThreadStatus
    balance: FiniteFloat
    label: str


class ThreadDateOut(BaseModel):
    """One ET date that realized a trade, in date order: a grouping key for the journal, nothing more. `balance` is the
    SIMULATED balance after that date's trades."""

    n: int  # 1-based over the dates that realized a trade
    day: date
    weekday: Weekday
    trades: int
    pnl_usd: FiniteFloat
    balance: FiniteFloat


class ThreadClockBriefOut(BaseModel):
    """Where the thread's time is, for a row of the hub's list (the clock route has the account and the market)."""

    clock: datetime
    running: bool
    speed: Literal[1, 2, 5, 10]
    start_at: datetime | None
    pause: dict[str, Any] | None  # {"kind": "horizon"}: the clock reached the latest available data and paused


class ThreadSummaryOut(BaseModel):
    """A thread with its plan and stats (the contract), its clock and how many positions it holds. A row of the hub's
    "Your threads" list. `clock` is null before the thread's plan starts it."""

    thread: PracticeThreadV1
    clock: ThreadClockBriefOut | None
    positions_open: int
    last_activity_at: datetime | None  # wall-clock UTC of the last lane touched or trade booked; null while fresh
    label: str

    @field_serializer("thread")
    def _thread_as_authored(
        self, thread: PracticeThreadV1
    ):  # no return annotation: the schema stays `PracticeThreadV1`
        """An empty stat or an unset limit is absent, never null (the Zod contract does not accept null there)."""
        return thread.model_dump(mode="json", by_alias=True, exclude_none=True)


class CurvePointOut(BaseModel):
    """A point of the balance curve: `n` 0 is the starting balance (no date), then one per date with a trade."""

    n: int
    day: date | None
    balance: FiniteFloat


class ThreadOut(ThreadSummaryOut):
    daily: list[ThreadDateOut]
    curve: list[CurvePointOut]


class FillOut(BaseModel):
    """One execution of a thread: a Buy or a Sell with its shares, price and time. `closes` of the shares closed the
    name's position and `opens` opened or added to one (a flip has both). `day` is the data day its lane opened on."""

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
    """The newest executions of a thread, newest booking first. `total` counts every one."""

    thread_id: int
    total: int
    fills: list[FillOut]


class ClockAccountOut(BaseModel):
    """The simulated account at the clock: the ledger's `balance` (realized), what every open position is worth over its
    cost at the clock (`open_pnl_usd`), and `equity_usd`, the two together; `since_start_usd` is equity less the
    starting balance. `buying_power_usd` is the cash an entry can use: the balance less the cost of the open
    positions and the cash its working orders hold back, the figure the order check enforces. Every position is
    marked by one function at the clock, never past it."""

    balance: FiniteFloat
    open_pnl_usd: FiniteFloat
    equity_usd: FiniteFloat
    buying_power_usd: FiniteFloat
    since_start_usd: FiniteFloat
    positions: int
    as_of: datetime


class ThreadCapacityOut(BaseModel):
    """The thread slots, shared by every user: at most `day_max` active threads at once. Closing a thread frees a slot.
    The field names keep their contract names until the contract migration."""

    day_active: int
    day_max: int


class ThreadClockOut(BaseModel):
    """The freestyle thread's clock (ADR-0025, ADR-0018): real time, shifted. `clock` is the simulated time at
    `server_now` (a running clock was settled before this was built); a client may extrapolate it with `speed` between
    polls but never owns it. It runs through the close, the night and the weekend: nothing happens at them. `horizon`
    is the latest time it can reach (the extended close of the latest session available under the 15-minute embargo): a
    running clock stops there with `pause = {"kind": "horizon"}`. `next_open` is the first regular open after `clock`
    (the Next open preset), null past the horizon."""

    thread_id: int
    state: Literal["not_started", "paused", "running"]
    running: bool
    speed: Literal[1, 2, 5, 10]
    clock: datetime | None
    start_at: datetime | None
    horizon: datetime
    next_open: datetime | None
    pause: dict[str, Any] | None
    market: MarketOut | None = None  # the exchange's phase at `clock` (`last_bar_at` is null: a name's frame has it)
    server_now: datetime
    account: ClockAccountOut | None
    label: str


class ClockIn(BaseModel):
    """Play or pause (`running`), the speed, and a step or jump (`step` one bar; `to` a date and time with its UTC
    offset, no later than `horizon`). Any mix, at least one; a step or jump is forward only (a `to` in the past is a
    422)."""

    model_config = ConfigDict(extra="forbid")

    running: bool | None = None
    speed: Literal[1, 2, 5, 10] | None = None
    step: Literal["bar"] | None = None
    to: datetime | None = None

    @model_validator(mode="after")
    def _something_to_do(self) -> "ClockIn":
        if not self.model_fields_set:
            raise ValueError("Send running, speed, step or to")
        return self


class ThreadLedgerOut(BaseModel):
    """The newest ledger rows, newest first. `total` counts every row."""

    thread_id: int
    total: int
    entries: list[PracticeLedgerEntryV1]
    label: str

    @field_serializer("entries")
    def _entries_as_authored(self, entries: list[PracticeLedgerEntryV1]):
        return [entry.model_dump(mode="json", by_alias=True, exclude_none=True) for entry in entries]
