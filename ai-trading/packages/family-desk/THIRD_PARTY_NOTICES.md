# Third-Party Notices

The Family Desk adapts the code below. Each adapted file says so in its header.

## Vibe-Trading

Source: https://github.com/HKUDS/Vibe-Trading (pinned as `ai-trading/packages/vibe-trading`)

| Desk file | Adapted from | Changes |
|---|---|---|
| `backend/src/ai_trading/core/options_math.py` | `agent/src/quantlib/options.py` | Standard-library math instead of numpy/scipy; calls and puts only; no barrier options |
| `backend/src/ai_trading/core/levels.py` (`support_resistance`, `_clusters`) | `agent/src/tools/pattern_tool.py` (`find_peaks_valleys`, `support_resistance`) | Confirmed pivots only; the nearest level to the previous close |
| `backend/src/ai_trading/core/indicators.py` (`adx`) | `agent/src/skills/technical-basic/example_signal_engine.py` (`compute_adx`), commit `d402c2d` | This module's Wilder seeding rule (mean of the first `length` valid values, via `_wilder`) instead of an EWM-only smoothing with no explicit seed |

```text
MIT License

Copyright (c) 2026 Vibe-Trading Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
