"""Response models for the practice threads of `/api/desk/replay/threads` (02r).

What she authors (`PracticeThreadCreateV1`, `PracticeThreadPatchV1`) and what the server reads back
(`PracticeThreadV1`, `PracticeLedgerEntryV1`) are contracts (`ai_trading.contracts.practice_thread`); the rest is
plain Pydantic. Every dollar figure is SIMULATED: `label` says so in words wherever a balance travels.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, FiniteFloat, field_serializer

from ai_trading.contracts.practice_thread import PracticeLedgerEntryV1, PracticeThreadV1

ThreadMode = Literal["day", "swing"]
ThreadStatus = Literal["active", "closed"]
Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri"]


class ThreadBriefOut(BaseModel):
    """The header strip of a day screen or the workspace: the SIMULATED balance and today's realized P/L (null when no
    practice day is under way; an open trade is not realized)."""

    id: int
    mode: ThreadMode
    status: ThreadStatus
    balance: FiniteFloat
    today_pnl_usd: FiniteFloat | None
    label: str


class ThreadTodayOut(BaseModel):
    """The practice day under way and what it has realized so far."""

    day_list_id: int
    day: date
    weekday: Weekday
    day_no: int
    status: Literal["listed", "practicing"]
    trades: int
    pnl_usd: FiniteFloat


class ThreadSummaryOut(BaseModel):
    """A thread with its plan and stats (the contract), and today. A row of the hub's "Your threads" list."""

    thread: PracticeThreadV1
    today: ThreadTodayOut | None
    label: str

    @field_serializer("thread")
    def _thread_as_authored(
        self, thread: PracticeThreadV1
    ):  # no return annotation: the schema stays `PracticeThreadV1`
        """An empty stat or an unset limit is absent, never null (the Zod contract does not accept null there)."""
        return thread.model_dump(mode="json", by_alias=True, exclude_none=True)


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


class CurvePointOut(BaseModel):
    """A point of the balance curve: `n` 0 is the starting balance (no day), then one per ended day."""

    n: int
    day: date | None
    balance: FiniteFloat


class ThreadOut(ThreadSummaryOut):
    daily: list[ThreadDayOut]
    curve: list[CurvePointOut]


class ThreadLedgerOut(BaseModel):
    """The newest ledger rows, newest first. `total` counts every row."""

    thread_id: int
    total: int
    entries: list[PracticeLedgerEntryV1]
    label: str

    @field_serializer("entries")
    def _entries_as_authored(self, entries: list[PracticeLedgerEntryV1]):
        return [entry.model_dump(mode="json", by_alias=True, exclude_none=True) for entry in entries]
