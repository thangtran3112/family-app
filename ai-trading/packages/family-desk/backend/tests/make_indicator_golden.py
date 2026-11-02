"""Regenerates `contracts/fixtures/indicator-golden-v1/golden.json`, the numbers both the backend
(`tests/test_indicator_golden.py`) and the frontend (`lib/indicators.golden.test.ts`) pin their indicators to.

    cd backend && uv run --with ta-lib python tests/make_indicator_golden.py

TA-Lib is the reference library and is NOT a project dependency (Alpaca serves bars, not indicator values);
`--with` installs it for this one run. The input is real: Alpaca SIP bars for TSLA recorded in
`tests/fixtures/desk-replay/day-tsla-2026-09-25.json.gz` (300 daily bars, and one-minute bars either side of the
2026-09-24 close and 2026-09-25 open). Three independent sources of every number are compared before the file is
written: TA-Lib, the plain-Python loops below (no pandas), and `ai_trading.core.indicators`.

Convention note: the Desk seeds an EMA with the first value (pandas `ewm(adjust=False)`); TA-Lib seeds with the
SMA of the first `length` values. The two differ by a transient that decays by (1 - alpha) per bar, so TA-Lib is
asserted at the LAST bar (converged), and the early bars are pinned by the plain-Python recursion instead.
"""

import gzip
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import talib

from ai_trading.core import indicators

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "fixtures" / "desk-replay" / "day-tsla-2026-09-25.json.gz"
TARGET = HERE.parents[1] / "contracts" / "fixtures" / "indicator-golden-v1" / "golden.json"
NEW_YORK = ZoneInfo("America/New_York")


def ema_ref(values, length):
    alpha, out, ema = 2 / (length + 1), [], None
    for i, x in enumerate(values):
        ema = x if ema is None else alpha * x + (1 - alpha) * ema
        out.append(ema if i >= length - 1 else None)
    return out


def wilder_ref(values, length):
    """Wilder's smoothing seeded by the mean of the first `length` values; index i of the result is for values[i]."""
    out = [None] * len(values)
    avg = sum(values[:length]) / length
    out[length - 1] = avg
    for i in range(length, len(values)):
        avg = (avg * (length - 1) + values[i]) / length
        out[i] = avg
    return out


def rsi_ref(closes, length=14):
    deltas = [b - a for a, b in zip(closes, closes[1:], strict=False)]
    gain = wilder_ref([max(d, 0.0) for d in deltas], length)
    loss = wilder_ref([max(-d, 0.0) for d in deltas], length)
    out = [None]  # no delta for the first bar
    for g, lo in zip(gain, loss, strict=True):
        out.append(None if g is None else 100.0 if lo == 0 else 100 - 100 / (1 + g / lo))
    return out


def atr_ref(highs, lows, closes, length=14):
    tr = [highs[0] - lows[0]] + [
        max(h, pc) - min(lo, pc) for h, lo, pc in zip(highs[1:], lows[1:], closes[:-1], strict=True)
    ]
    return wilder_ref(tr, length)


def macd_ref(closes, fast=12, slow=26, signal=9):
    ef, es = ema_ref(closes, fast), ema_ref(closes, slow)
    line = [None if a is None or b is None else a - b for a, b in zip(ef, es, strict=True)]
    first = next(i for i, v in enumerate(line) if v is not None)
    sig_tail = ema_ref([v for v in line if v is not None], signal)
    sig = [None] * first + sig_tail
    hist = [None if s is None else ln - s for ln, s in zip(line, sig, strict=True)]
    return line, sig, hist


def close_enough(a, b, tolerance):
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= tolerance)


def nan_to_none(series):
    return [None if np.isnan(v) else float(v) for v in series]


def main() -> None:
    raw = json.load(gzip.open(SOURCE))

    # ---- daily ----
    daily_rows = [[d, h, lo, c] for d, _o, h, lo, c, _v in raw["daily_300"]["rows"]]
    highs, lows, closes = (np.array([r[i] for r in daily_rows], float) for i in (1, 2, 3))
    frame = pd.DataFrame({"high": highs, "low": lows, "close": closes})
    reference = {
        "sma_20": talib.SMA(closes, 20),
        "ema_9": talib.EMA(closes, 9),
        "ema_21": talib.EMA(closes, 21),
        "rsi_14": talib.RSI(closes, 14),
        "atr_14": talib.ATR(highs, lows, closes, 14),
    }
    t_line, t_sig, t_hist = talib.MACD(closes, 12, 26, 9)
    reference.update(macd_line=t_line, macd_signal=t_sig, macd_histogram=t_hist)
    last = {name: float(values[-1]) for name, values in reference.items()}

    macd_b = indicators.macd(frame["close"])
    plain_line, plain_sig, plain_hist = macd_ref(list(closes))
    series = {  # name -> (plain-Python, backend)
        "ema_9": (ema_ref(list(closes), 9), nan_to_none(indicators.ema(frame["close"], 9))),
        "ema_21": (ema_ref(list(closes), 21), nan_to_none(indicators.ema(frame["close"], 21))),
        "rsi_14": (rsi_ref(list(closes)), nan_to_none(indicators.rsi(frame["close"], 14))),
        "macd_line": (plain_line, nan_to_none(macd_b.line)),
        "macd_signal": (plain_sig, nan_to_none(macd_b.signal)),
        "macd_histogram": (plain_hist, nan_to_none(macd_b.histogram)),
        "atr_14": (atr_ref(list(highs), list(lows), list(closes)), nan_to_none(indicators.atr(frame, 14))),
    }
    for name, (plain, backend) in series.items():
        for i, (p, b) in enumerate(zip(plain, backend, strict=True)):
            assert close_enough(p, b, 1e-9), (name, i, p, b)
        if name in last:
            assert abs(plain[-1] - last[name]) < 1e-6, (name, plain[-1], last[name])  # the converged bar vs TA-Lib
    # The moving averages the technicals panel reports. An SMA has no seed, so it is exact. An EMA is compared only
    # where it has converged (300 bars is 14+ time constants for lengths up to 20; EMA 50/100/200 have not converged,
    # which is the seed convention showing, not an error).
    for length in (5, 10, 20, 50, 100, 200):
        reference[f"sma_{length}"] = talib.SMA(closes, length)
        last[f"sma_{length}"] = float(reference[f"sma_{length}"][-1])
        assert abs(float(indicators.sma(frame["close"], length).iloc[-1]) - last[f"sma_{length}"]) < 1e-9
    for length in (5, 10, 20):
        reference[f"ema_{length}"] = talib.EMA(closes, length)
        last[f"ema_{length}"] = float(reference[f"ema_{length}"][-1])
        assert abs(float(indicators.ema(frame["close"], length).iloc[-1]) - last[f"ema_{length}"]) < 1e-6

    # The bias gauge's other oscillators: TA-Lib's definitions are the same, so the last bar agrees (Wilder's ADX seeds
    # differently, which is a transient too). Only the last bar is pinned.
    stoch_k, stoch_d = talib.STOCH(highs, lows, closes, 14, 3, 0, 3, 0)
    stoch, adx = indicators.stochastic(frame, 14, 3, 3), indicators.adx(frame, 14)
    power = indicators.bull_bear_power(frame, 13)
    ema_13 = talib.EMA(closes, 13)
    oscillators = {
        "stoch_k": (stoch_k, stoch.k),
        "stoch_d": (stoch_d, stoch.d),
        "cci_20": (talib.CCI(highs, lows, closes, 20), indicators.cci(frame, 20)),
        "williams_r_14": (talib.WILLR(highs, lows, closes, 14), indicators.williams_r(frame, 14)),
        "momentum_10": (talib.MOM(closes, 10), indicators.momentum(frame["close"], 10)),
        "adx_14": (talib.ADX(highs, lows, closes, 14), adx.adx),
        "plus_di_14": (talib.PLUS_DI(highs, lows, closes, 14), adx.plus_di),
        "minus_di_14": (talib.MINUS_DI(highs, lows, closes, 14), adx.minus_di),
        "ultimate_oscillator": (talib.ULTOSC(highs, lows, closes, 7, 14, 28), indicators.ultimate_oscillator(frame)),
        "bull_power_13": (highs - ema_13, power.bull),
        "bear_power_13": (lows - ema_13, power.bear),
    }
    for name, (talib_values, backend_values) in oscillators.items():
        last[name] = float(talib_values[-1])
        assert abs(float(backend_values.iloc[-1]) - last[name]) < 1e-6, (name, backend_values.iloc[-1], last[name])

    # Early bars: first defined bar, the next one, and 30 bars on (still in the transient where a first-value seed
    # and an SMA seed disagree), from the plain-Python loops.
    first = {"ema_9": 8, "ema_21": 20, "rsi_14": 14, "macd_line": 25, "macd_signal": 33, "macd_histogram": 33}
    warmup = {name: [[i, series[name][0][i]] for i in (start, start + 1, start + 30)] for name, start in first.items()}
    warmup["atr_14"] = [[i, series["atr_14"][0][i]] for i in (13, 14, 43)]

    # ---- one-minute ----
    every_minute = raw["prior_bars_1m"]["rows"] + raw["bars_1m"]["rows"]
    wanted = []
    for t, _o, h, lo, c, v, phase in every_minute:
        stamp = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(NEW_YORK)
        key = (stamp.date().isoformat(), stamp.strftime("%H:%M"))
        in_window = (
            ("2026-09-24", "15:40") <= key < ("2026-09-24", "16:20")  # last 20 regular minutes + 20 after-hours
            or ("2026-09-25", "09:10") <= key < ("2026-09-25", "11:00")  # 20 pre-market minutes + 90 regular
        )
        if in_window:
            clock = stamp.strftime("%H:%M")
            assert (phase == "regular") == ("09:30" <= clock < "16:00"), (t, phase)
            wanted.append([t, h, lo, c, v, phase])
    assert len(wanted) == 150, len(wanted)

    expected_vwap, day, cum_pv, cum_v = [], None, 0.0, 0.0
    for t, h, lo, c, v, phase in wanted:
        if phase != "regular":
            expected_vwap.append(None)
            continue
        et_day = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(NEW_YORK).date()
        if et_day != day:
            day, cum_pv, cum_v = et_day, 0.0, 0.0
        cum_pv += (h + lo + c) / 3 * v
        cum_v += v
        expected_vwap.append(cum_pv / cum_v)

    out = {
        "source": "Alpaca SIP bars for TSLA (backend/tests/fixtures/desk-replay/day-tsla-2026-09-25.json.gz)",
        "reference": f"TA-Lib {talib.__version__} at the last daily bar; plain-Python loops for early bars and VWAP",
        "generator": "backend/tests/make_indicator_golden.py",
        "daily": {"cols": ["day", "h", "l", "c"], "rows": daily_rows},
        "daily_last": last,
        "daily_warmup": warmup,
        "minutes": {"cols": ["t", "h", "l", "c", "v", "phase"], "rows": wanted},
        "vwap": expected_vwap,
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {TARGET} ({TARGET.stat().st_size} bytes)")
    print(json.dumps(last, indent=1))
    print(json.dumps(warmup["ema_21"]), json.dumps(expected_vwap[-1]))


if __name__ == "__main__":
    main()
