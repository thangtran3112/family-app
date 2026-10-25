"""The compressed-blob history cache (02o §h.2, owner request): one row per (kind, symbol, day, part, feed) in
`replay_blobs`, holding a zlib-compressed numpy archive. Bars and prints of a finished past day never change,
so a blob is written once and read forever; a day fetched once never touches Alpaca again.

Codec ("npz-v1"): prices are stored as integer micro-dollars (delta-encoded), times as nanosecond integers
(delta-encoded), so a tape chunk of 170,000 prints compresses to about 1 MB. Prices round-trip exactly: Alpaca
quotes at most 4 decimals and `round(p * 1e6) / 1e6` is the correctly rounded double of that decimal.
"""

import io
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal, NamedTuple, Protocol

import numpy as np
import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ai_trading.db.models import ReplayBlob

PRICE_SCALE = 1_000_000

Kind = Literal["bars1m", "bars1d", "tape"]


class BlobKey(NamedTuple):
    kind: Kind
    symbol: str
    day: date
    part: str  # "" for bars; a tape chunk's start as UTC "HHMM"
    feed: str  # "sip" | "iex"


class BlobStore(Protocol):
    def get(self, key: BlobKey) -> bytes | None: ...

    def put(self, key: BlobKey, payload: bytes, rows: int, raw_bytes: int) -> None: ...

    def keys(self, kind: Kind, symbol: str, days: list[date]) -> set[BlobKey]: ...


class MemoryBlobStore:
    """The tests' store: a dict, with a read counter."""

    def __init__(self) -> None:
        self.blobs: dict[BlobKey, bytes] = {}
        self.reads = 0

    def get(self, key: BlobKey) -> bytes | None:
        self.reads += 1
        return self.blobs.get(key)

    def put(self, key: BlobKey, payload: bytes, rows: int, raw_bytes: int) -> None:
        self.blobs.setdefault(key, payload)

    def keys(self, kind: Kind, symbol: str, days: list[date]) -> set[BlobKey]:
        return {k for k in self.blobs if k.kind == kind and k.symbol == symbol and k.day in set(days)}


@dataclass
class DbBlobStore:
    """`replay_blobs` through a request's session. A concurrent writer of the same key wins silently."""

    db: Session

    def get(self, key: BlobKey) -> bytes | None:
        row = self.db.execute(
            select(ReplayBlob.payload).where(
                ReplayBlob.kind == key.kind,
                ReplayBlob.symbol == key.symbol,
                ReplayBlob.day == key.day,
                ReplayBlob.part == key.part,
                ReplayBlob.feed == key.feed,
            )
        ).scalar_one_or_none()
        return None if row is None else bytes(row)

    def put(self, key: BlobKey, payload: bytes, rows: int, raw_bytes: int) -> None:
        self.db.execute(
            insert(ReplayBlob)
            .values(
                kind=key.kind,
                symbol=key.symbol,
                day=key.day,
                part=key.part,
                feed=key.feed,
                payload=payload,
                row_count=rows,
                raw_bytes=raw_bytes,
                created_at=datetime.now(UTC),
            )
            .on_conflict_do_nothing()
        )
        self.db.flush()

    def keys(self, kind: Kind, symbol: str, days: list[date]) -> set[BlobKey]:
        rows = self.db.execute(
            select(ReplayBlob.kind, ReplayBlob.symbol, ReplayBlob.day, ReplayBlob.part, ReplayBlob.feed).where(
                ReplayBlob.kind == kind, ReplayBlob.symbol == symbol, ReplayBlob.day.in_(days)
            )
        ).all()
        return {BlobKey(*row) for row in rows}


def stats(db: Session) -> list[tuple[str, int, int, int]]:
    """`(kind, blobs, rows, stored bytes)` per kind, for the prep CLI's status line."""
    rows = db.execute(
        select(
            ReplayBlob.kind,
            func.count(),
            func.coalesce(func.sum(ReplayBlob.row_count), 0),
            func.coalesce(func.sum(func.length(ReplayBlob.payload)), 0),
        ).group_by(ReplayBlob.kind)
    ).all()
    return [(kind, int(n), int(r), int(b)) for kind, n, r, b in rows]


# -- codec --------------------------------------------------------------------------------------------------


def _pack(arrays: dict[str, np.ndarray], meta: dict) -> bytes:
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **arrays, meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8))
    return buffer.getvalue()


def _unpack(payload: bytes) -> tuple[dict[str, np.ndarray], dict]:
    with np.load(io.BytesIO(payload), allow_pickle=False) as archive:
        arrays = {name: archive[name] for name in archive.files if name != "meta"}
        meta = json.loads(archive["meta"].tobytes().decode())
    return arrays, meta


def _micro(prices: np.ndarray) -> np.ndarray:
    return np.rint(np.asarray(prices, dtype="float64") * PRICE_SCALE).astype("int64")


def _delta(values: np.ndarray) -> np.ndarray:
    return np.diff(values, prepend=0) if len(values) else values.astype("int64")


def encode_bars(frame: pd.DataFrame) -> tuple[bytes, int]:
    """A 1-minute bar frame (UTC index; open/high/low/close/volume) to `(blob, raw byte count)`."""
    # pandas 3 keeps the unit the data arrived in (often microseconds): ask for nanoseconds explicitly.
    nanos = frame.index.tz_convert("UTC").as_unit("ns").asi8 if len(frame) else np.array([], dtype="int64")
    arrays = {
        "t": _delta(nanos),
        "o": _delta(_micro(frame["open"].to_numpy())),
        "h": _micro(frame["high"].to_numpy()),
        "l": _micro(frame["low"].to_numpy()),
        "c": _micro(frame["close"].to_numpy()),
        "v": frame["volume"].to_numpy(dtype="float64"),
    }
    return _pack(arrays, {"fmt": "npz-v1", "kind": "bars"}), len(frame) * 6 * 8


def decode_bars(payload: bytes) -> pd.DataFrame:
    arrays, _ = _unpack(payload)
    index = pd.DatetimeIndex(np.cumsum(arrays["t"]).astype("datetime64[ns]"), tz="UTC")
    return pd.DataFrame(
        {
            "open": np.cumsum(arrays["o"]) / PRICE_SCALE,
            "high": arrays["h"] / PRICE_SCALE,
            "low": arrays["l"] / PRICE_SCALE,
            "close": arrays["c"] / PRICE_SCALE,
            "volume": arrays["v"],
        },
        index=index,
    )


def encode_daily(frame: pd.DataFrame) -> tuple[bytes, int]:
    """A daily bar frame (index of `date`) to `(blob, raw byte count)`."""
    days = np.array([d.toordinal() for d in frame.index], dtype="int64")
    arrays = {
        "d": days,
        "o": _micro(frame["open"].to_numpy()),
        "h": _micro(frame["high"].to_numpy()),
        "l": _micro(frame["low"].to_numpy()),
        "c": _micro(frame["close"].to_numpy()),
        "v": frame["volume"].to_numpy(dtype="float64"),
    }
    return _pack(arrays, {"fmt": "npz-v1", "kind": "daily"}), len(frame) * 6 * 8


def decode_daily(payload: bytes) -> pd.DataFrame:
    arrays, _ = _unpack(payload)
    index = [date.fromordinal(int(d)) for d in arrays["d"]]
    return pd.DataFrame(
        {
            "open": arrays["o"] / PRICE_SCALE,
            "high": arrays["h"] / PRICE_SCALE,
            "low": arrays["l"] / PRICE_SCALE,
            "close": arrays["c"] / PRICE_SCALE,
            "volume": arrays["v"],
        },
        index=pd.Index(index, dtype=object),
    )


@dataclass(frozen=True)
class TapeChunk:
    """Five minutes of consolidated prints. `t` is nanoseconds since the epoch (UTC), oldest first; `u` marks
    the prints that update the last sale (the pinned condition set, `tape.NOT_LAST_SALE`)."""

    t: np.ndarray
    p: np.ndarray
    s: np.ndarray
    u: np.ndarray

    @property
    def raw_count(self) -> int:
        return len(self.t)

    @property
    def raw_shares(self) -> int:
        return int(self.s.sum())


def encode_tape(t: np.ndarray, p: np.ndarray, s: np.ndarray, conditions: list[str]) -> tuple[bytes, int]:
    """Prints to `(blob, raw byte count)`. `conditions` is the Alpaca condition string of each print ("@TI")."""
    vocab = sorted(set(conditions))
    lookup = {text: i for i, text in enumerate(vocab)}
    codes = np.fromiter((lookup[text] for text in conditions), dtype="uint16", count=len(conditions))
    arrays = {"t": _delta(t.astype("int64")), "p": _delta(_micro(p)), "s": s.astype("int64"), "c": codes}
    return _pack(arrays, {"fmt": "npz-v1", "kind": "tape", "vocab": vocab}), len(t) * 30


def decode_tape(payload: bytes, not_last_sale: frozenset[str]) -> TapeChunk:
    arrays, meta = _unpack(payload)
    ineligible = np.array([any(ch in not_last_sale for ch in text) for text in meta["vocab"]], dtype=bool)
    codes = arrays["c"]
    return TapeChunk(
        t=np.cumsum(arrays["t"]),
        p=np.cumsum(arrays["p"]) / PRICE_SCALE,
        s=arrays["s"],
        u=~ineligible[codes] if len(codes) else np.array([], dtype=bool),
    )
