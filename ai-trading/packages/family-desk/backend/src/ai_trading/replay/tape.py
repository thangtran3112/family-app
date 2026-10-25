"""The tape service (02o decision 2): consolidated prints for a replayed window, read-only history.

- **Source.** Alpaca historical SIP trades through the registry `trades` kind, fetched on demand in 5-minute
  chunks (pages of 10,000 inside the adapter). `iex` is a labelled fallback used only when SIP is refused.
- **Cache.** A chunk is decoded once into numpy arrays, kept in a small process LRU, and stored compressed in
  `replay_blobs` (`cache.py`), so a chunk fetched once is never fetched again. A chunk whose end is inside the
  provider's 15-minute embargo is not stored (it would be incomplete).
- **Eligibility.** A print whose condition codes include one of `NOT_LAST_SALE` does not update the last sale
  and is dropped from the tape (R0 verified Alpaca's minute bars count every print, so the raw chunk still sums
  to the bar volume; only the display drops them).
- **Ticks** follow the tick rule over eligible prints (up, down, same); there is no bid or ask in this data.
"""

import logging
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal

import numpy as np
import pandas as pd
from ai_trading_common.errors import NoData, NotConfigured
from ai_trading_common.registry import DataSources

from ai_trading.replay.cache import BlobKey, BlobStore, TapeChunk, decode_tape, encode_tape

log = logging.getLogger(__name__)

Feed = Literal["sip", "iex"]

#: Conditions that do not update the last sale: C cash, N next day, R seller, U and Z out of sequence,
#: V contingent, W average price, 7 qualified contingent, H price variation, and the auction reference prints
#: Q (official open), M (official close), 9 (corrected close). Odd lots (I) and derivatively priced (4) stay in
#: (R0, run-r0.json: Alpaca's minute bars count every print, including these).
NOT_LAST_SALE = frozenset("CHNRUVWZ79MQ")
BIG_PRINT_USD = 1_000_000
CHUNK = pd.Timedelta(minutes=5)
CHUNK_NS = int(CHUNK.value)
EMBARGO = pd.Timedelta(minutes=15)
PACE_WINDOW_S = 10
LOOKBACK_CHUNKS = 4  # how far back "the last print at or before t" searches when t's own chunk has none
LRU_CHUNKS = 24

#: Pace bands as multiples of the prior 10-session average shares per second (R0 thresholds).
PACE_BANDS = ((1.5, "quiet"), (4.0, "steady"), (8.0, "busy"))


def chunk_start(t: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(t.value - t.value % CHUNK_NS, tz="UTC")


def band_of(x_of_avg: float) -> str:
    for limit, name in PACE_BANDS:
        if x_of_avg < limit:
            return name
    return "frantic"


class Prints:
    """Eligible prints of a window, as parallel arrays (time in ns since the epoch)."""

    __slots__ = ("p", "s", "t")

    def __init__(self, t: np.ndarray, p: np.ndarray, s: np.ndarray) -> None:
        self.t, self.p, self.s = t, p, s

    def __len__(self) -> int:
        return len(self.t)

    @property
    def volume(self) -> int:
        return int(self.s.sum())

    @staticmethod
    def empty() -> "Prints":
        return Prints(np.array([], "int64"), np.array([], "float64"), np.array([], "int64"))

    @staticmethod
    def concat(parts: list["Prints"]) -> "Prints":
        parts = [part for part in parts if len(part)]
        if not parts:
            return Prints.empty()
        return Prints(*(np.concatenate([getattr(part, name) for part in parts]) for name in ("t", "p", "s")))


def ticks(prices: np.ndarray, previous_price: float | None) -> np.ndarray:
    """Tick rule: 1 when the price is above the previous eligible print, -1 below, 0 the same (or no previous)."""
    if not len(prices):
        return np.array([], dtype="int8")
    before = np.concatenate([[prices[0] if previous_price is None else previous_price], prices[:-1]])
    return np.sign(prices - before).astype("int8")


def select_rows(
    prints: Prints, tick: np.ndarray, *, min_size: int = 0, min_notional: int = 0, max_prints: int = 500
) -> tuple[list[tuple[pd.Timestamp, float, int, int]], int]:
    """`(rows, kept)`: the size-filtered rows, the latest `max_prints` of them, oldest first; `kept` is how many
    passed the filter before the cap."""
    keep = np.ones(len(prints), dtype=bool)
    if min_size:
        keep &= prints.s >= min_size
    if min_notional:
        keep &= prints.p * prints.s >= min_notional
    index = np.flatnonzero(keep)
    kept = len(index)
    index = index[-max_prints:]
    rows = [
        (pd.Timestamp(int(prints.t[i]), tz="UTC"), float(prints.p[i]), int(prints.s[i]), int(tick[i])) for i in index
    ]
    return rows, kept


def pace(window: Prints, *, seconds: int, avg_shares_per_s: float | None) -> dict:
    """Eligible prints and shares per market second over the last `seconds` seconds."""
    shares_per_s = window.volume / seconds
    x = None if not avg_shares_per_s else round(shares_per_s / avg_shares_per_s, 2)
    return {
        "window_s": seconds,
        "prints_per_s": round(len(window) / seconds, 2),
        "shares_per_s": round(shares_per_s, 1),
        "x_of_avg": x,
        "band": None if x is None else band_of(x),
    }


class Tape:
    """Prints for (symbol, window). One per process; the LRU is shared by every session."""

    def __init__(
        self,
        sources: DataSources,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._sources = sources
        self._now = now
        self._lru: OrderedDict[tuple[str, int, str], TapeChunk] = OrderedDict()
        self.fetches = 0  # provider chunk fetches, for tests and the prep CLI's report

    # -- chunks ----------------------------------------------------------------------------------------------

    def chunk(self, store: BlobStore, symbol: str, start: pd.Timestamp, feed: Feed) -> TapeChunk:
        """The 5-minute chunk at `start` (a multiple of five minutes): the LRU, then the blob store, then Alpaca."""
        key = (symbol, start.value, feed)
        if key in self._lru:
            self._lru.move_to_end(key)
            return self._lru[key]
        blob_key = BlobKey("tape", symbol, start.date(), start.strftime("%H%M"), feed)
        payload = store.get(blob_key)
        if payload is None:
            payload = self._fetch(store, blob_key, symbol, start, feed)
        chunk = decode_tape(payload, NOT_LAST_SALE)
        self._lru[key] = chunk
        while len(self._lru) > LRU_CHUNKS:
            self._lru.popitem(last=False)
        return chunk

    def _fetch(self, store: BlobStore, blob_key: BlobKey, symbol: str, start: pd.Timestamp, feed: Feed) -> bytes:
        end = start + CHUNK
        result = self._sources.trades.trades(symbol, start, end - pd.Timedelta(nanoseconds=1), feed=feed)
        self.fetches += 1
        frame = result.frame
        payload, raw = encode_tape(
            frame["t"].to_numpy(dtype="datetime64[ns]").astype("int64") if len(frame) else np.array([], "int64"),
            frame["p"].to_numpy(dtype="float64"),
            frame["s"].to_numpy(dtype="int64"),
            frame["c"].tolist(),
        )
        # An incomplete chunk (still inside the provider's embargo) is served but never stored.
        if pd.Timestamp(self._now()) - EMBARGO >= end:
            store.put(blob_key, payload, len(frame), raw)
        return payload

    def probe_feed(self, store: BlobStore, symbol: str, start: pd.Timestamp) -> Feed:
        """`sip` unless the provider refuses it, then `iex` (labelled in the UI). Reads one chunk: warms the cache."""
        try:
            self.chunk(store, symbol, chunk_start(start), "sip")
            return "sip"
        except NotConfigured:
            log.warning("SIP trades refused; the tape falls back to IEX prints")
            self.chunk(store, symbol, chunk_start(start), "iex")
            return "iex"
        except NoData:
            return "sip"

    # -- windows ---------------------------------------------------------------------------------------------

    def prints(self, store: BlobStore, symbol: str, after: pd.Timestamp, through: pd.Timestamp, feed: Feed) -> Prints:
        """Eligible prints with `after < time <= through`, oldest first."""
        if through <= after:
            return Prints.empty()
        parts = []
        cursor = chunk_start(after)
        while cursor <= through:
            chunk = self.chunk(store, symbol, cursor, feed)
            lo = np.searchsorted(chunk.t, after.value, side="right")
            hi = np.searchsorted(chunk.t, through.value, side="right")
            sel = slice(lo, hi)
            mask = chunk.u[sel]
            parts.append(Prints(chunk.t[sel][mask], chunk.p[sel][mask], chunk.s[sel][mask]))
            cursor += CHUNK
        return Prints.concat(parts)

    def last_print(
        self, store: BlobStore, symbol: str, through: pd.Timestamp, feed: Feed
    ) -> tuple[pd.Timestamp, float] | None:
        """The last eligible print at or before `through`, searching back at most `LOOKBACK_CHUNKS` chunks."""
        cursor = chunk_start(through)
        for _ in range(LOOKBACK_CHUNKS + 1):
            chunk = self.chunk(store, symbol, cursor, feed)
            hi = np.searchsorted(chunk.t, through.value, side="right")
            eligible = np.flatnonzero(chunk.u[:hi])
            if len(eligible):
                i = eligible[-1]
                return pd.Timestamp(int(chunk.t[i]), tz="UTC"), float(chunk.p[i])
            cursor -= CHUNK
        return None
