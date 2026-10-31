# Recorded vendor fixtures (stage C0)

Real Alpaca `/v2/stocks/{symbol}/bars` responses, recorded once from the free Basic plan and then
frozen. Format is `ai-trading/common/scripts/record.py`'s: `{"params": ..., "body": ...}`, response
bodies only, no headers and no secrets. They are replayed offline by
`internal/providers/alpaca/vendor_test.go` through a fake that applies the vendor's own window
(`start <= t <= end`, both inclusive), so a bad request window fails the test instead of passing on
a fake that returns everything.

Recorded 2026-10-31 (a Saturday) with the `ai-trading/market-data` key, `feed=sip`, `adjustment=all`
unless noted. Re-record only when the window must move; the parity golden in
`expected_python_bars.json` must then be regenerated with `tools/gen_parity_golden.py`.

| File | Window | Bars |
|---|---|---|
| `2026-10/daily_spy.json` | SPY `1Day`, 2026-09-25..2026-10-30 | 26 sessions |
| `2026-10/daily_aapl.json` | AAPL `1Day`, 2026-09-25..2026-10-30 | 26 sessions |
| `2026-10/daily_qqq.json` | QQQ `1Day`, 2026-09-25..2026-10-30 | 26 sessions |
| `2026-10/minute_spy_2026-10-30.json` | SPY `1Min`, 2026-10-30 19:50..20:10Z (the 16:00 ET close) | 21 |
| `2026-10/minute_aapl_2026-10-30.json` | AAPL `1Min`, 2026-10-30 13:25..13:40Z | 16 |
| `2024-06/daily_nvda_raw.json` | NVDA `1Day` `adjustment=raw`, 2024-06-05..2024-06-12 | 6 sessions |
| `2024-06/daily_nvda_split.json` | NVDA `1Day` `adjustment=split`, same window | 6 sessions |

## Known values, checked once at recording time

These literals are asserted by `TestRecordedWindowMatchesKnownValues` and the parity golden; they
are the anchor that keeps a replay from being self-consistent but wrong.

- SPY daily, last week of October 2026 (EDT, so a daily bar is stamped at midnight ET = `04:00Z`):
  `2026-10-26` close **765.37**, `2026-10-27` **769.66**, `2026-10-28` **772.31**,
  `2026-10-29` **769.36**, `2026-10-30` **755.72** (volume 77,867,645). Every close instant is
  `20:00Z`; the `2026-10-26T04:00:00Z` bar is the one the 5U bug used to drop.
- SPY in standard time (`common/tests/fixtures/alpaca/daily_range_spy.json`, January 2026): the
  daily stamp is `05:00Z`, the close instant `21:00Z`, and `2026-01-02` closed **677.84**. The
  one-session window `2026-01-02 04:00 ET .. 20:00 ET` returns exactly that bar.
- NVDA's real 10:1 split on 2024-06-10: `2024-06-07` closes **1208.88** raw and **120.89** split;
  `2024-06-10` is **121.79** either way, because the split took effect at that session's open. The
  session dates are identical in both adjustments.

## Not yet covered

`02u` §6.2 T1 asks for 2026-10-01..2026-11-06, which spans the 2026-11-01 DST end. On 2026-10-31
the November sessions (`2026-11-02`..) had not traded yet, so the recorded daily window stops at
2026-10-30. The standard-time half of the DST story is carried by January 2026 fixtures instead
(the daily range above, and `minute_dst_change.json` in the `common` set, which crosses the March
change). Add the November week to this window the next time it is re-recorded; the parity case list
in `tools/gen_parity_golden.py` is where a new case goes.